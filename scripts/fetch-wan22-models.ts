// Fetch the three model files the Wan 2.2 TI2V 5B image-to-video workflow needs (ADR-0008) into a
// ComfyUI models root. Idempotent: a file already present at its expected size is skipped, and the
// script prints where every file landed.
//
// Usage:
//   npx tsx scripts/fetch-wan22-models.ts [--models-root <dir>] [--dry-run]
//
// Default models root: ~/comfyui/models. No environment variables are read (ADR-0001 invariant is
// scoped to src/, but this script honors the same file/flag-only stance) — configure via --models-root.
//
// The download itself shells out to `curl -L -C -` (resume-friendly, shows progress) so a partial
// 10 GB file resumes instead of restarting. The SKIP DECISION is a pure function (planDownloads),
// unit-tested with a mocked stat — no network in the test.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { civitaiCurlArgs, resolveCivitaiToken } from "./lib/civitai.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface ModelSpec {
  file: string;
  subdir: string; // ComfyUI models subdir (diffusion_models / vae / text_encoders)
  size: number; // exact byte size from the HF repo — drives the skip decision
  url: string;
}

const HF_BASE =
  "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files";

// Pinned files + exact sizes, verified against the official Comfy-Org repackage (ADR-0008). NOTE:
// the 5B diffusion model is fp16 — there is no fp8 5B; fp8_scaled variants are all 14B.
export const WAN_MODELS: readonly ModelSpec[] = [
  {
    file: "wan2.2_ti2v_5B_fp16.safetensors",
    subdir: "diffusion_models",
    size: 9_999_658_848,
    url: `${HF_BASE}/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors`,
  },
  {
    file: "wan2.2_vae.safetensors",
    subdir: "vae",
    size: 1_409_400_960,
    url: `${HF_BASE}/vae/wan2.2_vae.safetensors`,
  },
  {
    file: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
    subdir: "text_encoders",
    size: 6_735_906_897,
    url: `${HF_BASE}/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors`,
  },
] as const;

export interface DownloadPlan {
  spec: ModelSpec;
  dest: string; // absolute path the file should land at
  action: "skip" | "download"; // skip => already present at the expected size
  existingSize?: number; // present but wrong size => re-download (partial/corrupt)
}

// Pure, testable: decide skip-vs-download for each spec given a stat function. A file counts as
// present ONLY when it exists AND matches the expected byte size exactly — a partial download (smaller)
// or a mismatch re-downloads (curl -C - resumes a partial). statFn returns undefined when absent.
export function planDownloads(
  models: readonly ModelSpec[],
  modelsRoot: string,
  statFn: (p: string) => { size: number } | undefined,
): DownloadPlan[] {
  return models.map((spec) => {
    const dest = path.join(modelsRoot, spec.subdir, spec.file);
    const st = statFn(dest);
    if (st && st.size === spec.size) {
      return { spec, dest, action: "skip" };
    }
    return { spec, dest, action: "download", existingSize: st?.size };
  });
}

function safeStat(p: string): { size: number } | undefined {
  try {
    return { size: statSync(p).size };
  } catch {
    return undefined;
  }
}

function parseArgs(argv: string[]): { modelsRoot: string; dryRun: boolean; civitaiToken: string } {
  let modelsRoot = path.join(os.homedir(), "comfyui", "models");
  let dryRun = false;
  let civitaiToken = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--models-root") {
      const next = argv[++i];
      if (!next) throw new Error("--models-root requires a directory argument");
      modelsRoot = path.resolve(next);
    } else if (argv[i] === "--civitai-token") {
      const next = argv[++i];
      if (!next) throw new Error("--civitai-token requires a value");
      civitaiToken = next;
    } else if (argv[i] === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return { modelsRoot, dryRun, civitaiToken };
}

function humanGB(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function main(): void {
  const { modelsRoot, dryRun, civitaiToken } = parseArgs(process.argv.slice(2));
  // The Wan files are all on Hugging Face, so this token is normally unused; it is wired in so a
  // Civitai-sourced mirror would authenticate. Resolved from the flag, else install/secrets.env.
  const token = resolveCivitaiToken(REPO_ROOT, civitaiToken);
  console.log(`ComfyUI models root: ${modelsRoot}`);
  const plans = planDownloads(WAN_MODELS, modelsRoot, safeStat);

  let downloaded = 0;
  let skipped = 0;
  for (const plan of plans) {
    if (plan.action === "skip") {
      console.log(`  [skip]     ${plan.spec.file} — already present (${humanGB(plan.spec.size)}) at ${plan.dest}`);
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
    const destDir = path.dirname(plan.dest);
    // curl handles mkdir via --create-dirs; -L follows the HF redirect, -C - resumes, -f fails loudly
    // on an HTTP error instead of writing an HTML error page over the model.
    const res = spawnSync(
      "curl",
      ["-L", "-f", "-C", "-", ...civitaiCurlArgs(plan.spec.url, token), "--create-dirs", "-o", plan.dest, plan.spec.url],
      { stdio: "inherit" },
    );
    if (res.status !== 0) {
      console.error(`\nFAILED to download ${plan.spec.file} (curl exit ${res.status ?? res.signal}).`);
      console.error("Re-run this script to resume — completed files are skipped, partials resume.");
      process.exit(1);
    }
    // Verify the finished size so a truncated transfer is caught, not silently accepted.
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
    console.log("All Wan 2.2 model files already in place.");
  }
}

// Run only when invoked directly, not when imported by the unit test.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
