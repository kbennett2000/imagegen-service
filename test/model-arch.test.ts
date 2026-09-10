import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  detectLatentChannels,
  detectPipeline,
  pipelineForChannels,
  resolveModelFile,
} from "../src/model-arch.ts";

// --- fixture builders (real on-disk headers, no tensor data needed for detection) ----------

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
function gstr(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([u64(b.length), b]);
}

// A safetensors file is: u64 header length + that many bytes of JSON. PyTorch shape [out, in, ...].
function writeSafetensors(dir: string, name: string, inChannels: number): string {
  const header = JSON.stringify({
    "patch_embedding.weight": { dtype: "F16", shape: [5120, inChannels, 1, 2, 2], data_offsets: [0, 0] },
    "some.other.weight": { dtype: "F16", shape: [10, 10], data_offsets: [0, 0] },
  });
  const hb = Buffer.from(header, "utf8");
  const p = path.join(dir, name);
  writeFileSync(p, Buffer.concat([u64(hb.length), hb]));
  return p;
}

// A minimal GGUF v3: magic, version, tensor_count, kv_count, [kvs], [tensor infos]. ggml dims are
// reversed vs PyTorch, so patch_embedding reads (kw, kh, kt, in_channels, out) and in_channels is [-2].
function writeGguf(dir: string, name: string, inChannels: number, withMetadata = false): string {
  const parts: Buffer[] = [Buffer.from("GGUF", "ascii"), u32(3)];
  const kvCount = withMetadata ? 2 : 0;
  parts.push(u64(1), u64(kvCount)); // 1 tensor
  if (withMetadata) {
    // a string KV and an array-of-uint32 KV, to exercise the metadata skip logic.
    parts.push(gstr("general.architecture"), u32(8), gstr("wan")); // type 8 = string
    parts.push(gstr("some.array"), u32(9), u32(4), u64(3), u32(1), u32(2), u32(3)); // type 9 array of u32
  }
  parts.push(gstr("patch_embedding.weight"), u32(5));
  for (const d of [2, 2, 1, inChannels, 5120]) parts.push(u64(d));
  parts.push(u32(0), u64(0)); // ggml type + data offset
  const p = path.join(dir, name);
  writeFileSync(p, Buffer.concat(parts));
  return p;
}

// --- tests ---------------------------------------------------------------------------------

test("pipelineForChannels maps 48/36/16 to the right pipeline, null otherwise", () => {
  assert.equal(pipelineForChannels(48), "wan22-ti2v");
  assert.equal(pipelineForChannels(36), "wan21-i2v");
  assert.equal(pipelineForChannels(16), "wan-t2v");
  assert.equal(pipelineForChannels(64), null);
  assert.equal(pipelineForChannels(null), null);
});

test("detectLatentChannels reads a safetensors patch-embedding in_channels", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "march-"));
  const f = writeSafetensors(dir, "model.safetensors", 48);
  assert.equal(await detectLatentChannels(f), 48);
});

test("detectLatentChannels reads a GGUF patch-embedding in_channels (with and without metadata)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "march-"));
  assert.equal(await detectLatentChannels(writeGguf(dir, "i2v.gguf", 36)), 36);
  assert.equal(await detectLatentChannels(writeGguf(dir, "t2v.gguf", 16, true)), 16);
});

test("detectLatentChannels returns null for a missing file or unknown format", async () => {
  assert.equal(await detectLatentChannels("/no/such/model.safetensors"), null);
  const dir = mkdtempSync(path.join(tmpdir(), "march-"));
  const p = path.join(dir, "notes.txt");
  writeFileSync(p, "hello");
  assert.equal(await detectLatentChannels(p), null);
});

test("resolveModelFile finds a name across roots and rejects traversal", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "march-"));
  writeSafetensors(dir, "found.safetensors", 36);
  assert.equal(resolveModelFile("found.safetensors", ["/nope", dir]), path.join(dir, "found.safetensors"));
  assert.equal(resolveModelFile("missing.safetensors", [dir]), null);
  assert.equal(resolveModelFile("../escape.safetensors", [dir]), null);
  assert.equal(resolveModelFile("/etc/passwd", [dir]), null);
});

test("detectPipeline resolves a name to its pipeline; null when undetectable", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "march-"));
  writeGguf(dir, "i2v.gguf", 36);
  writeSafetensors(dir, "ti2v.safetensors", 48);
  assert.deepEqual(await detectPipeline("i2v.gguf", [dir]), { pipeline: "wan21-i2v", channels: 36 });
  assert.deepEqual(await detectPipeline("ti2v.safetensors", [dir]), { pipeline: "wan22-ti2v", channels: 48 });
  assert.equal(await detectPipeline("absent.gguf", [dir]), null);
});

// --- endpoint: GET /detect-pipeline --------------------------------------------------------

import type { AddressInfo } from "node:net";
import type { Config } from "../src/config.ts";
import { createServer } from "../src/server.ts";

function cfgWithDirs(dirs: string[]): Config {
  return {
    comfyui: { url: "http://localhost:8188", checkpoint: "", upscaleModel: "", diffusionModelDirs: dirs },
    server: { host: "127.0.0.1", port: 0 },
    auth: { enabled: false, token: "" },
    gpuLock: { path: "/var/lock/gpu-tenant.lock", maxHoldMs: 1, idleGraceMs: 1, acquireTimeoutMs: 1, enabled: false },
  };
}

async function withServer(cfg: Config, fn: (base: string) => Promise<void>): Promise<void> {
  const server = createServer(cfg, (async () => new Response("{}")) as unknown as typeof fetch);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("GET /detect-pipeline returns the detected pipeline for a configured model dir", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "march-"));
  writeGguf(dir, "clip.gguf", 36);
  await withServer(cfgWithDirs([dir]), async (base) => {
    const res = await fetch(`${base}/detect-pipeline?model=clip.gguf`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { pipeline: "wan21-i2v", channels: 36 });
  });
});

test("GET /detect-pipeline returns pipeline:null when dirs are not configured", async () => {
  await withServer(cfgWithDirs([]), async (base) => {
    const res = await fetch(`${base}/detect-pipeline?model=whatever.gguf`);
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { pipeline: unknown }).pipeline, null);
  });
});
