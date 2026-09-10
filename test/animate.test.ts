import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { Config } from "../src/config.ts";
import { animateImage, formatVideoExecutionError, wanModelsMissing } from "../src/engine.ts";
import { createServer } from "../src/server.ts";
import { MockComfy } from "./helpers/mock-comfy.ts";

const URL = "http://localhost:8188";
const B64_STILL = Buffer.from("fake-png-bytes").toString("base64");

const CONFIG: Config = {
  comfyui: { url: URL, checkpoint: "", upscaleModel: "" },
  server: { host: "127.0.0.1", port: 0 },
  auth: { enabled: false, token: "" },
  // Lease disabled: lease.run() is a passthrough, so /animate behaves as before ADR-0012.
  gpuLock: {
    path: "/var/lock/gpu-tenant.lock",
    maxHoldMs: 1_260_000,
    idleGraceMs: 5_000,
    acquireTimeoutMs: 120_000,
    enabled: false,
  },
};

async function startService(
  mock: MockComfy,
  config: Config = CONFIG,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer(config, mock.fetch);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---- engine: animateImage ----------------------------------------------------------------

test("animateImage: happy path renders the Wan graph and returns the video bytes", async () => {
  const mock = new MockComfy({ outputFilename: (pid) => `${pid}.mp4` });
  const result = await animateImage(URL, { prompt: "a fox trots", image: B64_STILL, seed: 7 }, mock.fetch);
  assert.equal(result.ok, true);
  const r = result as { ok: true; bytes: Buffer; contentType: string; filename: string };
  assert.deepEqual(r.bytes, mock.bytesFor("pid-1"));
  assert.equal(r.contentType, "video/mp4");
  assert.match(r.filename, /\.mp4$/);

  // The submitted graph is the Wan i2v template with our params injected.
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["37"].class_type, "UNETLoader");
  assert.equal(graph["55"].class_type, "Wan22ImageToVideoLatent");
  assert.equal(graph["6"].inputs.text, "a fox trots");
  assert.equal(graph["3"].inputs.seed, 7);
  // The still was uploaded and its returned name wired into LoadImage 52.
  assert.equal(mock.uploads.length, 1);
  assert.equal(graph["52"].inputs.image, mock.uploads[0]);
});

test("animateImage: width/height/frames/fps flow into the graph (snapped by the engine)", async () => {
  const mock = new MockComfy();
  await animateImage(
    URL,
    { prompt: "p", image: B64_STILL, width: 640, height: 640, frames: 48, fps: 30 },
    mock.fetch,
  );
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["55"].inputs.width, 640);
  assert.equal(graph["55"].inputs.height, 640);
  assert.equal(graph["55"].inputs.length, 49); // 48 snapped to the 4k+1 grid
  assert.equal(graph["57"].inputs.fps, 30);
});

test("animateImage: no diffusion model installed -> clean, name-free error, nothing submitted", async () => {
  const mock = new MockComfy({ wanUnets: [] }); // no safetensors and (by default) no GGUF models
  const result = await animateImage(URL, { prompt: "p", image: B64_STILL }, mock.fetch);
  assert.equal(result.ok, false);
  const r = result as { ok: false; error: string };
  assert.match(r.error, /No image-to-video diffusion model is installed/);
  assert.match(r.error, /models\/diffusion_models\//);
  assert.equal(mock.submitted.length, 0); // preflight failed before any submit
});

test("animateImage: ComfyUI execution error surfaces as a failure", async () => {
  const mock = new MockComfy({ historyError: () => true });
  const result = await animateImage(URL, { prompt: "p", image: B64_STILL }, mock.fetch);
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; error: string }).error, /execution error/);
});

test("wanModelsMissing: [] when all present, lists the absent files otherwise", async () => {
  const present = new MockComfy();
  assert.deepEqual(await wanModelsMissing(URL, present.fetch), []);

  const noVae = new MockComfy({ wanVaes: [] });
  const missing = await wanModelsMissing(URL, noVae.fetch);
  assert.equal(missing.length, 1);
  assert.match(missing[0]!, /wan2\.2_vae\.safetensors/);
});

// ---- subfolder tolerance (ADR-0020) ------------------------------------------------------

test("wanModelsMissing: subfoldered (s/, ns/) installs still read present (basename match)", async () => {
  const sub = new MockComfy({
    wanUnets: ["sub/wan2.2_ti2v_5B_fp16.safetensors"],
    wanClips: ["sub/umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
    wanVaes: ["sub/wan2.2_vae.safetensors"],
  });
  assert.deepEqual(await wanModelsMissing(URL, sub.fetch), []);
});

test("animateImage: subfoldered model files load by their exact prefixed name (ADR-0020)", async () => {
  const mock = new MockComfy({
    outputFilename: (pid) => `${pid}.mp4`,
    wanUnets: ["sub/wan2.2_ti2v_5B_fp16.safetensors"],
    wanClips: ["sub/umt5_xxl_fp8_e4m3fn_scaled.safetensors"],
    wanVaes: ["sub/wan2.2_vae.safetensors"],
  });
  const result = await animateImage(URL, { prompt: "p", image: B64_STILL }, mock.fetch);
  assert.equal(result.ok, true); // preflight passes by basename, nothing "not installed"
  // The submitted graph asks ComfyUI for the exact prefixed names it advertises, not the bare ones.
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["37"].inputs.unet_name, "sub/wan2.2_ti2v_5B_fp16.safetensors");
  assert.equal(graph["38"].inputs.clip_name, "sub/umt5_xxl_fp8_e4m3fn_scaled.safetensors");
  assert.equal(graph["39"].inputs.vae_name, "sub/wan2.2_vae.safetensors");
});

test("animateImage: flat (unprefixed) installs are still injected verbatim", async () => {
  const mock = new MockComfy({ outputFilename: (pid) => `${pid}.mp4` });
  const result = await animateImage(URL, { prompt: "p", image: B64_STILL }, mock.fetch);
  assert.equal(result.ok, true);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["37"].inputs.unet_name, "wan2.2_ti2v_5B_fp16.safetensors");
  assert.equal(graph["39"].inputs.vae_name, "wan2.2_vae.safetensors");
});

// ---- Wan 2.1 i2v pipeline (ADR-0022 Phase 1) ---------------------------------------------

test("animateImage: pipeline=wan21-i2v renders the Wan 2.1 i2v graph (WanImageToVideo + clip-vision)", async () => {
  const mock = new MockComfy({
    outputFilename: (pid) => `${pid}.mp4`,
    wanUnets: [],
    wanGgufUnets: ["sub/video-model-a.gguf"],
  });
  const r = await animateImage(
    URL,
    { prompt: "come alive", image: B64_STILL, pipeline: "wan21-i2v", steps: 4, cfg: 1 },
    mock.fetch,
  );
  assert.equal(r.ok, true);
  const g = mock.submitted[0]!.graph;
  // GGUF model wired through UnetLoaderGGUF; the i2v-specific nodes are present.
  assert.equal(g["37"].class_type, "UnetLoaderGGUF");
  assert.equal(g["37"].inputs.unet_name, "sub/video-model-a.gguf");
  assert.equal(g["55"].class_type, "WanImageToVideo");
  assert.equal(g["40b"].class_type, "CLIPVisionEncode");
  assert.equal(g["39"].inputs.vae_name, "wan_2.1_vae.safetensors"); // 16-ch VAE, not the 2.2 one
  // Distilled-model sampler overrides flow through.
  assert.equal(g["3"].inputs.steps, 4);
  assert.equal(g["3"].inputs.cfg, 1);
  // The uploaded still feeds both the i2v latent builder and the clip-vision encoder.
  assert.equal(g["52"].inputs.image, mock.uploads[0]);
});

test("animateImage: pipeline=wan21-i2v with CLIP-vision missing -> clean, actionable error", async () => {
  const mock = new MockComfy({
    wanUnets: [],
    wanGgufUnets: ["sub/video-model-a.gguf"],
    clipVision: [], // no CLIP-vision installed
  });
  const r = (await animateImage(
    URL,
    { prompt: "p", image: B64_STILL, pipeline: "wan21-i2v" },
    mock.fetch,
  )) as { ok: false; error: string };
  assert.equal(r.ok, false);
  assert.match(r.error, /Wan 2\.1 i2v support files not installed/);
  assert.equal(mock.submitted.length, 0);
});

// ---- architecture-incompatibility error translation (ADR-0022) ---------------------------

test("formatVideoExecutionError: a tensor-size mismatch reads as an architecture message", () => {
  const mismatch = {
    status_str: "error",
    messages: [["execution_error", {
      node_id: "3", node_type: "KSampler", exception_type: "RuntimeError",
      exception_message: "The size of tensor a (48) must match the size of tensor b (16) at non-singleton dimension 1",
    }]],
  };
  const msg = formatVideoExecutionError(mismatch);
  assert.match(msg, /isn't compatible with the built-in Wan 2.2 TI2V workflow/);
  assert.match(msg, /Original error:/);

  // An unrelated execution error is passed through unchanged (still surfaced verbatim).
  const oom = {
    status_str: "error",
    messages: [["execution_error", {
      node_id: "3", node_type: "KSampler", exception_type: "RuntimeError",
      exception_message: "CUDA out of memory",
    }]],
  };
  assert.doesNotMatch(formatVideoExecutionError(oom), /isn't compatible/);
  assert.match(formatVideoExecutionError(oom), /CUDA out of memory/);
});

// ---- live discovery of installed video models (ADR-0021) ---------------------------------
// Tests use neutral placeholder names on purpose: no model name is compiled into this repo.

test("animateImage: the requested diffusion model is used; absent field falls back to the first", async () => {
  const opts = {
    outputFilename: (pid: string) => `${pid}.mp4`,
    wanUnets: ["sub/video-model-a.safetensors", "alt/video-model-b.safetensors"],
  };
  const mockPick = new MockComfy(opts);
  const picked = await animateImage(
    URL,
    { prompt: "p", image: B64_STILL, diffusionModel: "alt/video-model-b.safetensors" },
    mockPick.fetch,
  );
  assert.equal(picked.ok, true);
  assert.equal(mockPick.submitted[0]!.graph["37"].inputs.unet_name, "alt/video-model-b.safetensors");
  assert.equal(mockPick.submitted[0]!.graph["37"].class_type, "UNETLoader");

  const mockDefault = new MockComfy(opts);
  await animateImage(URL, { prompt: "p", image: B64_STILL }, mockDefault.fetch); // no diffusionModel
  assert.equal(mockDefault.submitted[0]!.graph["37"].inputs.unet_name, "sub/video-model-a.safetensors");
});

test("animateImage: a .gguf model loads through UnetLoaderGGUF (ADR-0021)", async () => {
  const mock = new MockComfy({
    outputFilename: (pid) => `${pid}.mp4`,
    wanUnets: [], // no plain safetensors diffusion model
    wanGgufUnets: ["sub/video-model-a.gguf"],
  });
  const result = await animateImage(
    URL,
    { prompt: "p", image: B64_STILL, diffusionModel: "sub/video-model-a.gguf" },
    mock.fetch,
  );
  assert.equal(result.ok, true);
  const node = mock.submitted[0]!.graph["37"];
  assert.equal(node.class_type, "UnetLoaderGGUF");
  assert.equal(node.inputs.unet_name, "sub/video-model-a.gguf");
  assert.equal(node.inputs.weight_dtype, undefined); // the GGUF loader takes only unet_name
});

test("animateImage: a requested model that isn't installed -> clean error, nothing submitted", async () => {
  const mock = new MockComfy({ wanUnets: ["sub/video-model-a.safetensors"] });
  const r = (await animateImage(
    URL,
    { prompt: "p", image: B64_STILL, diffusionModel: "not-there.safetensors" },
    mock.fetch,
  )) as { ok: false; error: string };
  assert.equal(r.ok, false);
  assert.match(r.error, /not installed/);
  assert.equal(mock.submitted.length, 0);
});

test("GET /health lists installed video models (safetensors + gguf) with nothing hardcoded", async () => {
  const mock = new MockComfy({
    wanUnets: ["sub/video-model-a.safetensors"],
    wanGgufUnets: ["alt/video-model-b.gguf"],
  });
  const svc = await startService(mock);
  try {
    const body = (await (await fetch(`${svc.base}/health`)).json()) as any;
    assert.deepEqual(body.videoModels, ["sub/video-model-a.safetensors", "alt/video-model-b.gguf"]);
    assert.equal(body.wan.ready, true);
  } finally {
    await svc.close();
  }
});

// ---- server: POST /animate ---------------------------------------------------------------

test("POST /animate -> 200 video/mp4 with the produced bytes", async () => {
  const mock = new MockComfy({ outputFilename: (pid) => `${pid}.mp4` });
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/animate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "come alive", image: B64_STILL }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, mock.bytesFor("pid-1"));
  } finally {
    await svc.close();
  }
});

test("POST /animate -> 422 on missing image", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/animate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "come alive" }),
    });
    assert.equal(res.status, 422);
    assert.match(((await res.json()) as any).error, /image/);
    assert.equal(mock.submitted.length, 0);
  } finally {
    await svc.close();
  }
});

test("POST /animate -> 422 on missing prompt", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/animate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: B64_STILL }),
    });
    assert.equal(res.status, 422);
    assert.match(((await res.json()) as any).error, /prompt/);
  } finally {
    await svc.close();
  }
});

test("POST /animate -> 422 on out-of-range frames", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/animate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "p", image: B64_STILL, frames: 500 }),
    });
    assert.equal(res.status, 422);
    assert.match(((await res.json()) as any).error, /frames/);
    assert.equal(mock.submitted.length, 0);
  } finally {
    await svc.close();
  }
});

test("POST /animate -> 503 when no diffusion model is installed", async () => {
  const mock = new MockComfy({ wanUnets: [] });
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/animate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "p", image: B64_STILL }),
    });
    assert.equal(res.status, 503);
    assert.match(((await res.json()) as any).error, /No image-to-video diffusion model is installed/);
  } finally {
    await svc.close();
  }
});

test("POST /animate -> 401 under auth without a token, 200 with it", async () => {
  const mock = new MockComfy({ outputFilename: (pid) => `${pid}.mp4` });
  const authConfig: Config = { ...CONFIG, auth: { enabled: true, token: "sekret" } };
  const svc = await startService(mock, authConfig);
  try {
    const noToken = await fetch(`${svc.base}/animate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "p", image: B64_STILL }),
    });
    assert.equal(noToken.status, 401);

    const withToken = await fetch(`${svc.base}/animate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sekret" },
      body: JSON.stringify({ prompt: "p", image: B64_STILL }),
    });
    assert.equal(withToken.status, 200);
  } finally {
    await svc.close();
  }
});

test("GET /health reports wan.ready true when models present, false + missing otherwise", async () => {
  const ready = await startService(new MockComfy());
  try {
    const body = (await (await fetch(`${ready.base}/health`)).json()) as any;
    assert.equal(body.wan.ready, true);
    assert.deepEqual(body.wan.missing, []);
  } finally {
    await ready.close();
  }

  const notReady = await startService(new MockComfy({ wanClips: [] }));
  try {
    const body = (await (await fetch(`${notReady.base}/health`)).json()) as any;
    assert.equal(body.wan.ready, false);
    assert.match(body.wan.missing.join(","), /umt5_xxl/);
  } finally {
    await notReady.close();
  }
});

// ---- model dispatch: LTX-Video (ADR-0015) ------------------------------------------------

test("animateImage: model=ltxv renders the LTX graph instead of Wan", async () => {
  const mock = new MockComfy({ outputFilename: (pid) => `${pid}.mp4` });
  const result = await animateImage(
    URL,
    { prompt: "a fox trots", image: B64_STILL, seed: 7, model: "ltxv" },
    mock.fetch,
  );
  assert.equal(result.ok, true);
  const graph = mock.submitted[0]!.graph;
  // LTX nodes, not Wan nodes.
  assert.equal(graph["77"].class_type, "LTXVImgToVideo");
  assert.equal(graph["44"].class_type, "CheckpointLoaderSimple");
  assert.equal(graph["44"].inputs.ckpt_name, "ltx-video-2b-v0.9.5.safetensors");
  assert.equal(graph["6"].inputs.text, "a fox trots");
  assert.equal(graph["72"].inputs.noise_seed, 7);
  assert.equal(graph["78"].inputs.image, mock.uploads[0]);
  assert.equal(graph["37"], undefined); // no Wan UNETLoader
});

test("animateImage: model=ltxv with its files missing -> clean error naming the LTX fetch script", async () => {
  // Advertise no checkpoints, so the LTX checkpoint preflight fails.
  const mock = new MockComfy({ checkpoints: [] });
  const result = await animateImage(URL, { prompt: "p", image: B64_STILL, model: "ltxv" }, mock.fetch);
  assert.equal(result.ok, false);
  const r = result as { ok: false; error: string };
  assert.match(r.error, /not installed/);
  assert.match(r.error, /ltx-video-2b-v0\.9\.5\.safetensors/);
  assert.match(r.error, /fetch-ltxv-models/);
  assert.equal(mock.submitted.length, 0);
});

test("animateImage: model=ltxv also tolerates subfoldered files (ADR-0020)", async () => {
  const mock = new MockComfy({
    outputFilename: (pid) => `${pid}.mp4`,
    checkpoints: ["sub/ltx-video-2b-v0.9.5.safetensors"],
    wanClips: ["sub/t5xxl_fp8_e4m3fn_scaled.safetensors"],
  });
  const result = await animateImage(URL, { prompt: "p", image: B64_STILL, model: "ltxv" }, mock.fetch);
  assert.equal(result.ok, true);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["44"].inputs.ckpt_name, "sub/ltx-video-2b-v0.9.5.safetensors");
  assert.equal(graph["38"].inputs.clip_name, "sub/t5xxl_fp8_e4m3fn_scaled.safetensors");
});

test("POST /animate: model=ltxv -> 200 video/mp4", async () => {
  const mock = new MockComfy({ outputFilename: (pid) => `${pid}.mp4` });
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/animate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "come alive", image: B64_STILL, model: "ltxv" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(mock.submitted[0]!.graph["77"].class_type, "LTXVImgToVideo");
  } finally {
    await svc.close();
  }
});

test("POST /animate: an unknown model -> 422, nothing submitted", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/animate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x", image: B64_STILL, model: "sora" }),
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as any;
    assert.match(body.error, /model/);
    assert.equal(mock.submitted.length, 0);
  } finally {
    await svc.close();
  }
});
