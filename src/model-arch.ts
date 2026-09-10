// Video-model architecture detection (ADR-0023). A model's workflow family is decided by its latent
// (patch-embedding IN-)channel count, which we read straight from the model file header — 48 = Wan 2.2
// TI2V, 36 = Wan 2.1 I2V, 16 = Wan T2V. This lets the service route a chosen model to a matching
// pipeline instead of the caller guessing (a "wan2.2"-branded file can be a 36-ch i2v model, etc.).
//
// It reads the file locally (ComfyUI is local per the project spec, ADR-0001). Best-effort and
// never-throw: any failure (dirs unset, file not found, unknown/broken format) yields null, and the
// caller falls back to an explicit pipeline. Supports .safetensors and .gguf (city96 ComfyUI-GGUF).

import { existsSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { VideoPipeline } from "./engine.js";

// The diffusion model's patch-embedding weight, common to both formats. PyTorch shape is
// [out_channels, in_channels, kt, kh, kw]; `in_channels` is the latent channel count we key on.
const PATCH_EMBED = "patch_embedding.weight";

// Map a latent channel count to the pipeline that drives it. null for an unrecognized count.
export function pipelineForChannels(channels: number | null): VideoPipeline | null {
  switch (channels) {
    case 48:
      return "wan22-ti2v";
    case 36:
      return "wan21-i2v";
    case 16:
      return "wan-t2v";
    default:
      return null;
  }
}

// The absolute path of a ComfyUI model name (possibly subfoldered, e.g. "ns/foo.gguf") within the
// configured diffusion-model roots, or null if it isn't found under any of them.
export function resolveModelFile(name: string, dirs: readonly string[]): string | null {
  // Guard against absolute paths / traversal in the ComfyUI-reported name (defensive; names are safe).
  if (!name || name.includes("..") || name.startsWith("/") || name.includes("\0")) return null;
  for (const dir of dirs) {
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

// Detect a model's latent channel count from its header. null when it can't be determined.
export async function detectLatentChannels(filePath: string): Promise<number | null> {
  try {
    if (filePath.toLowerCase().endsWith(".safetensors")) return await safetensorsChannels(filePath);
    if (filePath.toLowerCase().endsWith(".gguf")) return await ggufChannels(filePath);
    return null;
  } catch {
    return null;
  }
}

// End-to-end: resolve a ComfyUI model name to a file, read its channels, map to a pipeline.
export async function detectPipeline(
  name: string,
  dirs: readonly string[],
): Promise<{ pipeline: VideoPipeline; channels: number } | null> {
  const file = resolveModelFile(name, dirs);
  if (!file) return null;
  const channels = await detectLatentChannels(file);
  const pipeline = pipelineForChannels(channels);
  if (pipeline === null || channels === null) return null;
  return { pipeline, channels };
}

// --- safetensors ---------------------------------------------------------------------------
// Layout: u64 little-endian header length, then that many bytes of JSON {tensorName: {shape, ...}}.

const MAX_SAFETENSORS_HEADER = 64 * 1024 * 1024; // headers are small; cap to avoid a pathological read

async function safetensorsChannels(filePath: string): Promise<number | null> {
  const fh = await open(filePath, "r");
  try {
    const lenBuf = Buffer.alloc(8);
    await fh.read(lenBuf, 0, 8, 0);
    const headerLen = Number(lenBuf.readBigUInt64LE(0));
    if (!Number.isFinite(headerLen) || headerLen <= 0 || headerLen > MAX_SAFETENSORS_HEADER) return null;
    const json = Buffer.alloc(headerLen);
    await fh.read(json, 0, headerLen, 8);
    const header = JSON.parse(json.toString("utf8")) as Record<string, { shape?: number[] }>;
    const key = Object.keys(header).find((k) => k === PATCH_EMBED || k.endsWith(`.${PATCH_EMBED}`));
    const shape = key ? header[key]?.shape : undefined;
    // [out_channels, in_channels, ...] — in_channels is index 1.
    return Array.isArray(shape) && shape.length >= 2 ? shape[1]! : null;
  } finally {
    await fh.close();
  }
}

// --- GGUF ----------------------------------------------------------------------------------
// Header: "GGUF", u32 version, u64 tensor_count, u64 kv_count, then the metadata KVs, then the tensor
// infos. Each tensor info: name (u64 len + bytes), u32 n_dims, n_dims * u64 dims, u32 type, u64 offset.
// ggml stores dims reversed vs PyTorch, so patch_embedding reads (kw, kh, kt, in_channels, out) — the
// in_channels is the second-to-last dim.

// A tiny sequential reader over a FileHandle, buffering forward in chunks (metadata can be sizeable).
class GgufReader {
  private buf = Buffer.alloc(0);
  private bufStart = 0; // file offset the buffer begins at
  private pos = 0; // absolute file offset of the cursor
  constructor(private fh: FileHandle) {}

  private async ensure(n: number): Promise<Buffer> {
    const need = this.pos + n;
    if (this.pos >= this.bufStart && need <= this.bufStart + this.buf.length) {
      const off = this.pos - this.bufStart;
      return this.buf.subarray(off, off + n);
    }
    // Refill from the current cursor with a generous chunk.
    const chunk = Math.max(n, 1 << 20);
    const tmp = Buffer.alloc(chunk);
    const { bytesRead } = await this.fh.read(tmp, 0, chunk, this.pos);
    if (bytesRead < n) throw new Error("gguf: unexpected EOF");
    this.buf = tmp.subarray(0, bytesRead);
    this.bufStart = this.pos;
    return this.buf.subarray(0, n);
  }

  async u32(): Promise<number> {
    const b = await this.ensure(4);
    this.pos += 4;
    return b.readUInt32LE(0);
  }
  async u64(): Promise<number> {
    const b = await this.ensure(8);
    this.pos += 8;
    return Number(b.readBigUInt64LE(0));
  }
  async bytes(n: number): Promise<Buffer> {
    const b = Buffer.from(await this.ensure(n));
    this.pos += n;
    return b;
  }
  async gstr(): Promise<string> {
    const len = await this.u64();
    if (len < 0 || len > 1 << 20) throw new Error("gguf: absurd string length");
    return (await this.bytes(len)).toString("utf8");
  }
}

// GGUF metadata value type ids -> fixed byte width (for the scalar types). string/array handled apart.
const GGUF_SCALAR_WIDTH: Record<number, number> = {
  0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8,
};

async function ggufSkipValue(r: GgufReader, type: number): Promise<void> {
  if (type === 8) {
    await r.gstr();
  } else if (type === 9) {
    const subType = await r.u32();
    const count = await r.u64();
    for (let i = 0; i < count; i++) await ggufSkipValue(r, subType);
  } else {
    const w = GGUF_SCALAR_WIDTH[type];
    if (w === undefined) throw new Error(`gguf: unknown value type ${type}`);
    await r.bytes(w);
  }
}

async function ggufChannels(filePath: string): Promise<number | null> {
  const fh = await open(filePath, "r");
  try {
    const r = new GgufReader(fh);
    const magic = (await r.bytes(4)).toString("ascii");
    if (magic !== "GGUF") return null;
    await r.u32(); // version
    const tensorCount = await r.u64();
    const kvCount = await r.u64();
    for (let i = 0; i < kvCount; i++) {
      await r.gstr(); // key
      const type = await r.u32();
      await ggufSkipValue(r, type);
    }
    for (let i = 0; i < tensorCount; i++) {
      const name = await r.gstr();
      const nDims = await r.u32();
      const dims: number[] = [];
      for (let d = 0; d < nDims; d++) dims.push(await r.u64());
      await r.u32(); // ggml type
      await r.u64(); // data offset
      if (name === PATCH_EMBED || name.endsWith(`.${PATCH_EMBED}`)) {
        // dims are ggml-order (reversed): [..., in_channels, out_channels]; in_channels is dims[-2].
        return dims.length >= 2 ? dims[dims.length - 2]! : null;
      }
    }
    return null;
  } finally {
    await fh.close();
  }
}
