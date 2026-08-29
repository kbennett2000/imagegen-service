import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { planDownloads } from "../scripts/fetch-wan22-models.ts";
import { LTXV_MODELS } from "../scripts/fetch-ltxv-models.ts";

const ROOT = "/models";
const fakeStat = (sizes: Record<string, number>) => (p: string) =>
  p in sizes ? { size: sizes[p]! } : undefined;
const destOf = (m: (typeof LTXV_MODELS)[number]) => path.join(ROOT, m.subdir, m.file);

test("LTXV_MODELS: the two pinned files land in the correct ComfyUI subdirs, ungated HF", () => {
  const bySubdir = Object.fromEntries(LTXV_MODELS.map((m) => [m.subdir, m.file]));
  assert.equal(bySubdir["checkpoints"], "ltx-video-2b-v0.9.5.safetensors");
  assert.equal(bySubdir["text_encoders"], "t5xxl_fp8_e4m3fn_scaled.safetensors");
  for (const m of LTXV_MODELS) {
    assert.ok(m.url.startsWith("https://huggingface.co/"), "must be a Hugging Face URL");
    assert.ok(m.size > 0);
  }
});

test("planDownloads (reused): LTX files present at exact size are skipped, else downloaded", () => {
  const sizes: Record<string, number> = {};
  for (const m of LTXV_MODELS) sizes[destOf(m)] = m.size;
  for (const p of planDownloads(LTXV_MODELS, ROOT, [], fakeStat(sizes))) assert.equal(p.action, "skip");
  for (const p of planDownloads(LTXV_MODELS, ROOT, [], fakeStat({}))) assert.equal(p.action, "download");
});

test("planDownloads (reused): an LTX file under an extra root (second drive) is skipped", () => {
  const EXTRA = "/mnt/drive2/comfyui-models";
  const first = LTXV_MODELS[0]!;
  const extraPath = path.join(EXTRA, first.subdir, first.file);
  const plans = planDownloads(LTXV_MODELS, ROOT, [EXTRA], fakeStat({ [extraPath]: first.size }));
  const plan = plans.find((p) => p.spec.file === first.file)!;
  assert.equal(plan.action, "skip");
  assert.equal(plan.foundAt, extraPath);
});
