// Fetch every image-to-video model file /animate can use — Wan 2.2 TI2V 5B (ADR-0008) and
// LTX-Video 2B (ADR-0015) — into a ComfyUI models root, skipping any already present at its exact
// size. This is the video-model counterpart of scripts/fetch-missing-checkpoints.sh and shares its
// defaults (ADR-0017): it downloads to the SECOND DRIVE by default and searches BOTH drives (the
// built-in ~/comfyui/models and the second drive), so a file already present on either — in any
// subdir — is not re-downloaded.
//
// Usage:
//   npx tsx scripts/fetch-missing-video-models.ts [--models-root <dir>] [--extra-root <dir>]... [--dry-run] [--civitai-token TOK]
//
// It reuses the pinned specs (WAN_MODELS + LTXV_MODELS) and the pure, unit-tested planDownloads from
// the per-model fetchers, so filenames, byte sizes, and URLs have one source of truth. No env vars
// (ADR-0001): configure via flags; the Civitai token (unused for these HF files, wired for a mirror)
// comes from --civitai-token or install/secrets.env.

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { civitaiCurlArgs, resolveCivitaiToken } from "./lib/civitai.ts";
import { WAN_MODELS, planDownloads, type ModelSpec } from "./fetch-wan22-models.ts";
import { LTXV_MODELS } from "./fetch-ltxv-models.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The two ComfyUI model roots this deployment uses (ADR-0017), matching fetch-missing-checkpoints.sh:
// the second drive is the default download target; the built-in dir is always also searched.
const DRIVE_MOUNT = "/run/media/kb/2TB 02";
const SECOND_DRIVE_ROOT = `${DRIVE_MOUNT}/comfyui-models`;
const BUILTIN_ROOT = path.join(os.homedir(), "comfyui", "models");

// Every image-to-video model file across every /animate model, in one list.
export const VIDEO_MODELS: readonly ModelSpec[] = [...WAN_MODELS, ...LTXV_MODELS];

function safeStat(p: string): { size: number } | undefined {
  try {
    return { size: statSync(p).size };
  } catch {
    return undefined;
  }
}

// Is `mountPath` a mounted filesystem? Uses mountpoint(1) when available; if that binary is missing
// (status null), falls back to an existence check — an unmounted removable path doesn't exist.
function isMounted(mountPath: string): boolean {
  const res = spawnSync("mountpoint", ["-q", mountPath]);
  if (res.status === 0) return true;
  if (res.status === 1) return false;
  return existsSync(mountPath);
}

interface Args {
  modelsRoot: string;
  extraRoots: string[];
  dryRun: boolean;
  civitaiToken: string;
}

function parseArgs(argv: string[]): Args {
  let modelsRoot = SECOND_DRIVE_ROOT; // default download target: the second drive
  const extraRoots: string[] = [];
  let dryRun = false;
  let civitaiToken = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--models-root") {
      const next = argv[++i];
      if (!next) throw new Error("--models-root requires a directory argument");
      modelsRoot = path.resolve(next);
    } else if (argv[i] === "--extra-root") {
      const next = argv[++i];
      if (!next) throw new Error("--extra-root requires a directory argument");
      extraRoots.push(path.resolve(next));
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
  return { modelsRoot, extraRoots, dryRun, civitaiToken };
}

// The roots to also search (besides the primary modelsRoot), deduped: both default drives plus any
// --extra-root, minus the primary itself (planDownloads already searches that first).
export function searchRoots(modelsRoot: string, extraRoots: readonly string[]): string[] {
  const seen = new Set<string>([modelsRoot]);
  const out: string[] = [];
  for (const r of [BUILTIN_ROOT, SECOND_DRIVE_ROOT, ...extraRoots]) {
    if (r && !seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

function humanGB(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function main(): void {
  const { modelsRoot, extraRoots, dryRun, civitaiToken } = parseArgs(process.argv.slice(2));

  // Guard the removable-mount caveat (ADR-0017): if the destination is on the second drive but it
  // isn't mounted, curl would write into an empty mount point on the root filesystem. Refuse instead.
  if ((modelsRoot === DRIVE_MOUNT || modelsRoot.startsWith(DRIVE_MOUNT + path.sep)) && !isMounted(DRIVE_MOUNT)) {
    console.error(`The 2TB drive isn't mounted (${DRIVE_MOUNT}) — refusing to download to an unmounted path.`);
    console.error("Mount it (open it in Files, or 'udisksctl mount ...'), or pass --models-root to a mounted location.");
    process.exit(1);
  }

  const token = resolveCivitaiToken(REPO_ROOT, civitaiToken);
  const alsoSearch = searchRoots(modelsRoot, extraRoots);
  console.log(`ComfyUI models root: ${modelsRoot}`);
  if (alsoSearch.length) console.log(`Also searching:      ${alsoSearch.join(", ")}`);
  console.log();

  const plans = planDownloads(VIDEO_MODELS, modelsRoot, alsoSearch, safeStat);

  let downloaded = 0;
  let skipped = 0;
  for (const plan of plans) {
    if (plan.action === "skip") {
      console.log(`  [skip]     ${plan.spec.file} — already present (${humanGB(plan.spec.size)}) at ${plan.foundAt ?? plan.dest}`);
      skipped++;
      continue;
    }
    const why = plan.existingSize !== undefined
      ? `partial/mismatch (${humanGB(plan.existingSize)} on disk, want ${humanGB(plan.spec.size)})`
      : "absent";
    console.log(`  [download] ${plan.spec.file} — ${why}`);
    console.log(`             ${plan.spec.url}`);
    console.log(`             -> ${plan.dest}`);
    if (dryRun) {
      downloaded++;
      continue;
    }
    // -L follows the HF/mirror redirect, -f fails loudly on an HTTP error instead of writing an error
    // page over the model, -C - resumes a partial, --create-dirs makes the subdir. The Civitai auth
    // header is attached only for civitai.com hosts (a no-op for these Hugging Face URLs).
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
    console.log("All image-to-video model files already in place.");
  }
  console.log("Then make ComfyUI re-scan so new files appear (no sudo): scripts/rescan-models.sh");
}

// Run only when invoked directly, not when imported by the unit test.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
