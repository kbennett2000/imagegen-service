import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { Config } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import {
  buildConcatArgs,
  ffmpegAvailable,
  stitchVideos,
  type FfmpegRun,
} from "../src/stitch.ts";
import { MockComfy } from "./helpers/mock-comfy.ts";

// ---- engine: stitchVideos (ffmpeg injected — no real ffmpeg, CI-safe) --------------------

test("buildConcatArgs: concat demuxer, stream copy, output last", () => {
  assert.deepEqual(buildConcatArgs("/tmp/list.txt", "/tmp/out.mp4"), [
    "-y", "-f", "concat", "-safe", "0", "-i", "/tmp/list.txt", "-c", "copy", "/tmp/out.mp4",
  ]);
});

// A fake ffmpeg that records its args, reads the concat list, and writes the output file the real
// binary would have produced.
function fakeFfmpeg(capture: { args?: string[]; list?: string }): FfmpegRun {
  return async (args) => {
    capture.args = args;
    const listPath = args[args.indexOf("-i") + 1]!;
    capture.list = readFileSync(listPath, "utf8");
    writeFileSync(args[args.length - 1]!, Buffer.from("STITCHED-MP4"));
    return { code: 0, stderr: "" };
  };
}

test("stitchVideos: joins clips and returns the ffmpeg output bytes", async () => {
  const cap: { args?: string[]; list?: string } = {};
  const r = await stitchVideos([Buffer.from("aaa"), Buffer.from("bbb"), Buffer.from("ccc")], {
    run: fakeFfmpeg(cap),
  });
  assert.equal(r.ok, true);
  assert.equal((r as { ok: true; bytes: Buffer }).bytes.toString(), "STITCHED-MP4");
  // The concat list referenced all three written clips, in order.
  const files = (cap.list ?? "").trim().split("\n");
  assert.equal(files.length, 3);
  assert.ok(files.every((l) => /^file '.*clip-\d+\.mp4'$/.test(l)));
});

test("stitchVideos: fewer than 2 clips is rejected without invoking ffmpeg", async () => {
  let called = false;
  const r = await stitchVideos([Buffer.from("solo")], { run: async () => { called = true; return { code: 0, stderr: "" }; } });
  assert.equal(r.ok, false);
  assert.match((r as { ok: false; error: string }).error, /at least 2/);
  assert.equal(called, false);
});

test("stitchVideos: ffmpeg missing -> actionable error", async () => {
  const r = await stitchVideos([Buffer.from("a"), Buffer.from("b")], {
    run: async () => ({ code: null, stderr: "", missing: true }),
  });
  assert.equal(r.ok, false);
  assert.match((r as { ok: false; error: string }).error, /ffmpeg is not installed/);
});

test("stitchVideos: non-zero exit -> error with stderr tail", async () => {
  const r = await stitchVideos([Buffer.from("a"), Buffer.from("b")], {
    run: async () => ({ code: 1, stderr: "line1\nInvalid data found when processing input" }),
  });
  assert.equal(r.ok, false);
  assert.match((r as { ok: false; error: string }).error, /Invalid data found/);
});

test("ffmpegAvailable: true on a clean -version, false when missing", async () => {
  assert.equal(await ffmpegAvailable({ run: async () => ({ code: 0, stderr: "ffmpeg version 6" }) }), true);
  assert.equal(await ffmpegAvailable({ run: async () => ({ code: null, stderr: "", missing: true }) }), false);
});

// ---- server: POST /stitch (stitcher injected) --------------------------------------------

const CONFIG: Config = {
  comfyui: { url: "http://localhost:8188", checkpoint: "", upscaleModel: "" },
  server: { host: "127.0.0.1", port: 0 },
  auth: { enabled: false, token: "" },
};

const okStitch = async () => ({ ok: true as const, bytes: Buffer.from("JOINED") });

async function startService(
  deps: Parameters<typeof createServer>[2],
  config: Config = CONFIG,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer(config, new MockComfy().fetch, deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const twoClips = { clips: [Buffer.from("a").toString("base64"), Buffer.from("b").toString("base64")] };

test("POST /stitch -> 200 video/mp4 with the joined bytes", async () => {
  const svc = await startService({ stitchVideos: okStitch, ffmpegAvailable: async () => true });
  try {
    const res = await fetch(`${svc.base}/stitch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(twoClips),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp4");
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), "JOINED");
  } finally {
    await svc.close();
  }
});

test("POST /stitch -> 422 with fewer than 2 clips", async () => {
  const svc = await startService({ stitchVideos: okStitch, ffmpegAvailable: async () => true });
  try {
    const res = await fetch(`${svc.base}/stitch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clips: [Buffer.from("a").toString("base64")] }),
    });
    assert.equal(res.status, 422);
    assert.match(((await res.json()) as any).error, /at least 2/);
  } finally {
    await svc.close();
  }
});

test("POST /stitch -> 422 when clips is missing/not an array", async () => {
  const svc = await startService({ stitchVideos: okStitch, ffmpegAvailable: async () => true });
  try {
    const res = await fetch(`${svc.base}/stitch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notClips: 1 }),
    });
    assert.equal(res.status, 422);
    assert.match(((await res.json()) as any).error, /clips/);
  } finally {
    await svc.close();
  }
});

test("POST /stitch -> 503 when ffmpeg/concat fails", async () => {
  const svc = await startService({
    stitchVideos: async () => ({ ok: false as const, error: "ffmpeg is not installed on the server" }),
    ffmpegAvailable: async () => false,
  });
  try {
    const res = await fetch(`${svc.base}/stitch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(twoClips),
    });
    assert.equal(res.status, 503);
    assert.match(((await res.json()) as any).error, /ffmpeg/);
  } finally {
    await svc.close();
  }
});

test("POST /stitch -> 401 under auth without a token", async () => {
  const authConfig: Config = { ...CONFIG, auth: { enabled: true, token: "sekret" } };
  const svc = await startService({ stitchVideos: okStitch, ffmpegAvailable: async () => true }, authConfig);
  try {
    const res = await fetch(`${svc.base}/stitch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(twoClips),
    });
    assert.equal(res.status, 401);
  } finally {
    await svc.close();
  }
});

test("GET /health reports stitch.available from the ffmpeg probe", async () => {
  const on = await startService({ ffmpegAvailable: async () => true });
  try {
    assert.equal(((await (await fetch(`${on.base}/health`)).json()) as any).stitch.available, true);
  } finally {
    await on.close();
  }
  const off = await startService({ ffmpegAvailable: async () => false });
  try {
    assert.equal(((await (await fetch(`${off.base}/health`)).json()) as any).stitch.available, false);
  } finally {
    await off.close();
  }
});
