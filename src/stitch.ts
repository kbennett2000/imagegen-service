// Video stitching via ffmpeg's concat demuxer (ADR-0010). Clips from POST /animate are all H.264 at
// the same resolution/fps, so joining them is a lossless stream copy (`-c copy`) — no re-encode.
//
// ComfyUI-independent and self-contained: it shells out to the system `ffmpeg` binary (like
// scripts/fetch-wan22-models.ts shells out to `curl`), which is NOT an npm/runtime dependency. The
// ffmpeg invocation is injectable so unit tests exercise every path with no ffmpeg and no fs race,
// mirroring how the engine injects `fetch`.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type StitchResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; error: string };

// The result of running ffmpeg once. `missing: true` means the binary itself was not found (ENOENT),
// which the caller turns into an actionable "install ffmpeg" message rather than a generic failure.
export interface FfmpegRunResult {
  code: number | null;
  stderr: string;
  missing?: boolean;
}

// Runs ffmpeg with the given args to completion. Injectable; defaults to a real child_process spawn.
export type FfmpegRun = (args: string[]) => Promise<FfmpegRunResult>;

export interface StitchOptions {
  run?: FfmpegRun;
  tmpRoot?: string; // parent dir for the temp workspace (default os.tmpdir())
}

const MAX_STDERR_KEEP = 4000;

// Default runner: spawn `ffmpeg <args>`, capture stderr, resolve on close. Never rejects — a spawn
// error (e.g. ffmpeg not installed) resolves as { missing: true } so the caller can branch cleanly.
const defaultRun: FfmpegRun = (args) =>
  new Promise((resolve) => {
    let stderr = "";
    let child;
    try {
      child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      resolve({ code: null, stderr: "", missing: true });
      return;
    }
    child.on("error", (err: NodeJS.ErrnoException) => {
      resolve({ code: null, stderr: String(err?.message ?? err), missing: err?.code === "ENOENT" });
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < MAX_STDERR_KEEP) stderr += d.toString();
    });
    child.on("close", (code) => resolve({ code, stderr }));
  });

// Build the ffmpeg concat-demuxer argument list. Pure, so it is unit-tested directly. The output path
// is intentionally the LAST argument (tests read it to simulate ffmpeg writing the result).
export function buildConcatArgs(listPath: string, outPath: string): string[] {
  // -y overwrite, concat demuxer over a list file, -safe 0 to allow absolute paths, -c copy = stream
  // copy (lossless, no re-encode; valid because the clips share codec/size/fps).
  return ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath];
}

// Join clips (raw mp4 bytes, in order) into one mp4. Writes them to a temp workspace, runs the concat,
// returns the bytes, and always cleans up. Never throws — every failure is an { ok: false } result.
export async function stitchVideos(clips: Buffer[], opts: StitchOptions = {}): Promise<StitchResult> {
  if (!Array.isArray(clips) || clips.length < 2) {
    return { ok: false, error: "need at least 2 clips to stitch" };
  }
  const run = opts.run ?? defaultRun;
  const tmpRoot = opts.tmpRoot ?? os.tmpdir();

  let dir: string | undefined;
  try {
    dir = mkdtempSync(path.join(tmpRoot, "stitch-"));
    // Write each clip to its own file and build the concat list. ffmpeg's concat list format is one
    // `file '<path>'` line per input; single-quotes in a path are escaped per ffmpeg's rules.
    const lines: string[] = [];
    for (let i = 0; i < clips.length; i++) {
      const clipPath = path.join(dir, `clip-${i}.mp4`);
      writeFileSync(clipPath, clips[i]!);
      lines.push(`file '${clipPath.replace(/'/g, "'\\''")}'`);
    }
    const listPath = path.join(dir, "list.txt");
    writeFileSync(listPath, lines.join("\n") + "\n");
    const outPath = path.join(dir, "out.mp4");

    const result = await run(buildConcatArgs(listPath, outPath));
    if (result.missing) {
      return { ok: false, error: "ffmpeg is not installed on the server (needed to stitch videos)" };
    }
    if (result.code !== 0) {
      const tail = result.stderr.trim().split("\n").slice(-4).join(" ").slice(-300);
      return { ok: false, error: `ffmpeg failed to stitch the clips${tail ? `: ${tail}` : ""}` };
    }

    let bytes: Buffer;
    try {
      bytes = readFileSync(outPath);
    } catch {
      return { ok: false, error: "ffmpeg reported success but produced no output" };
    }
    if (!bytes.length) return { ok: false, error: "ffmpeg produced an empty file" };
    return { ok: true, bytes };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `stitch failed: ${reason}` };
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

// Is ffmpeg present on the host? A quick `ffmpeg -version`. Injectable runner; false on any failure.
export async function ffmpegAvailable(opts: { run?: FfmpegRun } = {}): Promise<boolean> {
  const run = opts.run ?? defaultRun;
  try {
    const r = await run(["-version"]);
    return !r.missing && r.code === 0;
  } catch {
    return false;
  }
}
