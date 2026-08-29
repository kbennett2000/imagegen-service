// Fetch the two model files the LTX-Video 2B image-to-video workflow needs (ADR-0015) into a ComfyUI
// models root. Idempotent: a file already present at its expected size is skipped. Mirrors
// scripts/fetch-wan22-models.ts and reuses its pure, unit-tested planDownloads.
//
// Usage:
//   npx tsx scripts/fetch-ltxv-models.ts [--models-root <dir>] [--extra-root <dir>]... [--dry-run]
//
// Default models root: ~/comfyui/models. Both files are on UNGATED Hugging Face repos — no token
// needed. The v0.9.5 checkpoint bundles its VAE, so only two files: the checkpoint + the T5 encoder.
// --extra-root points at additional ComfyUI models roots (e.g. a second drive; ADR-0017): a full-size
// copy found under any of them counts as present and is skipped. Downloads still land in --models-root.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { planDownloads, type ModelSpec } from "./fetch-wan22-models.ts";

// Pinned files + exact byte sizes, verified against the HF API (Lightricks/LTX-Video and
// Comfy-Org/mochi_preview_repackaged, both ungated).
export const LTXV_MODELS: readonly ModelSpec[] = [
  {
    file: "ltx-video-2b-v0.9.5.safetensors",
    subdir: "checkpoints",
    size: 6_340_729_500,
    url: "https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.5.safetensors",
  },
  {
    file: "t5xxl_fp8_e4m3fn_scaled.safetensors",
    subdir: "text_encoders",
    size: 5_157_348_688,
    url: "https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/text_encoders/t5xxl_fp8_e4m3fn_scaled.safetensors",
  },
] as const;

function safeStat(p: string): { size: number } | undefined {
  try {
    return { size: statSync(p).size };
  } catch {
    return undefined;
  }
}

function parseArgs(argv: string[]): { modelsRoot: string; dryRun: boolean; extraRoots: string[] } {
  let modelsRoot = path.join(os.homedir(), "comfyui", "models");
  let dryRun = false;
  const extraRoots: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--models-root") {
      const next = argv[++i];
      if (!next) throw new Error("--models-root requires a directory argument");
      modelsRoot = path.resolve(next);
    } else if (argv[i] === "--extra-root") {
      const next = argv[++i];
      if (!next) throw new Error("--extra-root requires a directory argument");
      extraRoots.push(path.resolve(next));
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return { modelsRoot, dryRun, extraRoots };
}

function humanGB(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function main(): void {
  const { modelsRoot, dryRun, extraRoots } = parseArgs(process.argv.slice(2));
  console.log(`ComfyUI models root: ${modelsRoot}`);
  if (extraRoots.length) console.log(`Also searching: ${extraRoots.join(", ")}`);
  const plans = planDownloads(LTXV_MODELS, modelsRoot, extraRoots, safeStat);

  let downloaded = 0;
  let skipped = 0;
  for (const plan of plans) {
    if (plan.action === "skip") {
      console.log(`  [skip]     ${plan.spec.file} — already present (${humanGB(plan.spec.size)}) at ${plan.foundAt ?? plan.dest}`);
      skipped++;
      continue;
    }
    const why = plan.existingSize !== undefined ? `partial/mismatch (${humanGB(plan.existingSize)} on disk, want ${humanGB(plan.spec.size)})` : `absent`;
    console.log(`  [download] ${plan.spec.file} — ${why}`);
    console.log(`             ${plan.spec.url}`);
    console.log(`             -> ${plan.dest}`);
    if (dryRun) {
      downloaded++;
      continue;
    }
    const res = spawnSync(
      "curl",
      ["-L", "-f", "-C", "-", "--create-dirs", "-o", plan.dest, plan.spec.url],
      { stdio: "inherit" },
    );
    if (res.status !== 0) {
      console.error(`\nFAILED to download ${plan.spec.file} (curl exit ${res.status ?? res.signal}).`);
      console.error("Re-run this script to resume — completed files are skipped, partials resume.");
      process.exit(1);
    }
    const after = safeStat(plan.dest);
    if (!after || after.size !== plan.spec.size) {
      console.error(`\nFAILED: ${plan.spec.file} is ${after ? humanGB(after.size) : "missing"} after download, expected ${humanGB(plan.spec.size)}.`);
      console.error("Re-run to resume the transfer.");
      process.exit(1);
    }
    console.log(`  [done]     ${plan.spec.file} — ${humanGB(plan.spec.size)} at ${plan.dest}`);
    downloaded++;
  }

  console.log(`\n${dryRun ? "[dry-run] " : ""}Done: ${downloaded} to fetch, ${skipped} already present.`);
  if (!dryRun && skipped === plans.length) {
    console.log("All LTX-Video model files already in place.");
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
