import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { Config } from "../src/config.ts";
import { animateImage, wanModelsMissing } from "../src/engine.ts";
import { createServer } from "../src/server.ts";
import { MockComfy } from "./helpers/mock-comfy.ts";

const URL = "http://localhost:8188";
const B64_STILL = Buffer.from("fake-png-bytes").toString("base64");

const CONFIG: Config = {
  comfyui: { url: URL, checkpoint: "", upscaleModel: "" },
  server: { host: "127.0.0.1", port: 0 },
  auth: { enabled: false, token: "" },
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

test("animateImage: missing Wan models -> clean error, nothing submitted", async () => {
  const mock = new MockComfy({ wanUnets: [] });
  const result = await animateImage(URL, { prompt: "p", image: B64_STILL }, mock.fetch);
  assert.equal(result.ok, false);
  const r = result as { ok: false; error: string };
  assert.match(r.error, /not installed/);
  assert.match(r.error, /wan2\.2_ti2v_5B_fp16\.safetensors/);
  assert.match(r.error, /fetch-wan22-models/);
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

test("POST /animate -> 503 when the Wan models are not installed", async () => {
  const mock = new MockComfy({ wanUnets: [] });
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/animate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "p", image: B64_STILL }),
    });
    assert.equal(res.status, 503);
    assert.match(((await res.json()) as any).error, /not installed/);
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
