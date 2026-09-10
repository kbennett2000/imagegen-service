import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { planDownloads, WAN_MODELS, type ModelSpec } from "../scripts/fetch-wan22-models.ts";
import { LTXV_MODELS } from "../scripts/fetch-ltxv-models.ts";
import { VIDEO_MODELS, searchRoots } from "../scripts/fetch-missing-video-models.ts";

const BUILTIN = path.join(os.homedir(), "comfyui", "models");
const SECOND_DRIVE = "/run/media/kb/2TB 02/comfyui-models";

function fakeStat(sizes: Record<string, number>) {
  return (p: string): { size: number } | undefined => (p in sizes ? { size: sizes[p]! } : undefined);
}

test("VIDEO_MODELS: the combined list is exactly Wan + LTX-Video, no drops", () => {
  assert.equal(VIDEO_MODELS.length, WAN_MODELS.length + LTXV_MODELS.length);
  const files = VIDEO_MODELS.map((m) => m.file);
  assert.ok(files.includes("wan2.2_ti2v_5B_fp16.safetensors")); // Wan diffusion model
  assert.ok(files.includes("ltx-video-2b-v0.9.5.safetensors")); // LTX-Video checkpoint
});

test("searchRoots: both drives searched by default, primary excluded, extras kept, deduped", () => {
  // Default (dest = second drive): the built-in drive is the other root searched; the primary is not
  // listed again (planDownloads searches it first).
  assert.deepEqual(searchRoots(SECOND_DRIVE, []), [BUILTIN]);
  // A custom dest still searches BOTH default drives, and not the custom dest itself.
  const custom = searchRoots("/custom/root", []);
  assert.ok(custom.includes(BUILTIN) && custom.includes(SECOND_DRIVE));
  assert.ok(!custom.includes("/custom/root"));
  // An --extra-root is appended; a duplicate of the primary is dropped.
  assert.ok(searchRoots("/custom/root", ["/mnt/x"]).includes("/mnt/x"));
  assert.ok(!searchRoots("/custom/root", ["/custom/root"]).includes("/custom/root"));
});

test("planDownloads over the combined list: a copy on either drive is skipped, dest stays primary", () => {
  const ROOT = SECOND_DRIVE; // primary download target
  const wan = WAN_MODELS[0]!; // present under the built-in drive
  const ltxv = LTXV_MODELS[0]!; // present under the primary
  const sizes = {
    [path.join(BUILTIN, wan.subdir, wan.file)]: wan.size,
    [path.join(ROOT, ltxv.subdir, ltxv.file)]: ltxv.size,
  };
  const plans = planDownloads(VIDEO_MODELS, ROOT, searchRoots(ROOT, []), fakeStat(sizes));

  const wanPlan = plans.find((p) => p.spec.file === wan.file)!;
  assert.equal(wanPlan.action, "skip");
  assert.equal(wanPlan.foundAt, path.join(BUILTIN, wan.subdir, wan.file)); // found on the other drive
  assert.equal(wanPlan.dest, path.join(ROOT, wan.subdir, wan.file)); // dest still the primary

  assert.equal(plans.find((p) => p.spec.file === ltxv.file)!.action, "skip");
  // Everything else is absent from both drives and downloads to the primary.
  assert.equal(plans.filter((p) => p.action === "download").length, VIDEO_MODELS.length - 2);
});
