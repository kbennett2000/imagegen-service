import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { planDownloads, WAN_MODELS, type ModelSpec } from "../scripts/fetch-wan22-models.ts";

const ROOT = "/models";

// A stat function backed by a fixed name->size map, standing in for the filesystem (no network,
// no disk). Absent files return undefined, matching statSync-that-threw.
function fakeStat(sizes: Record<string, number>) {
  return (p: string): { size: number } | undefined =>
    p in sizes ? { size: sizes[p]! } : undefined;
}

function destOf(spec: ModelSpec): string {
  return path.join(ROOT, spec.subdir, spec.file);
}

test("planDownloads: absent files are scheduled for download", () => {
  const plans = planDownloads(WAN_MODELS, ROOT, fakeStat({}));
  assert.equal(plans.length, WAN_MODELS.length);
  for (const p of plans) {
    assert.equal(p.action, "download");
    assert.equal(p.existingSize, undefined);
    assert.equal(p.dest, destOf(p.spec));
  }
});

test("planDownloads: files present at the exact expected size are skipped", () => {
  const sizes: Record<string, number> = {};
  for (const spec of WAN_MODELS) sizes[destOf(spec)] = spec.size;
  const plans = planDownloads(WAN_MODELS, ROOT, fakeStat(sizes));
  for (const p of plans) assert.equal(p.action, "skip");
});

test("planDownloads: a present-but-wrong-size file re-downloads (partial/corrupt)", () => {
  const first = WAN_MODELS[0]!;
  const sizes = { [destOf(first)]: first.size - 1024 }; // truncated partial
  const plans = planDownloads(WAN_MODELS, ROOT, fakeStat(sizes));
  const plan = plans.find((p) => p.spec.file === first.file)!;
  assert.equal(plan.action, "download");
  assert.equal(plan.existingSize, first.size - 1024);
});

test("planDownloads: mixed state — one present, the rest absent", () => {
  const vae = WAN_MODELS.find((m) => m.subdir === "vae")!;
  const plans = planDownloads(WAN_MODELS, ROOT, fakeStat({ [destOf(vae)]: vae.size }));
  assert.equal(plans.find((p) => p.spec.file === vae.file)!.action, "skip");
  assert.equal(plans.filter((p) => p.action === "download").length, WAN_MODELS.length - 1);
});

test("WAN_MODELS: the three pinned files land in the correct ComfyUI subdirs", () => {
  const bySubdir = Object.fromEntries(WAN_MODELS.map((m) => [m.subdir, m.file]));
  assert.equal(bySubdir["diffusion_models"], "wan2.2_ti2v_5B_fp16.safetensors");
  assert.equal(bySubdir["vae"], "wan2.2_vae.safetensors");
  assert.equal(bySubdir["text_encoders"], "umt5_xxl_fp8_e4m3fn_scaled.safetensors");
  for (const m of WAN_MODELS) assert.ok(m.url.startsWith("https://huggingface.co/Comfy-Org/"));
});
