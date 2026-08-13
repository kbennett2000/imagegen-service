# ADR-0010: Video stitching endpoint (POST /stitch)

## Status
Accepted

## Context
`POST /animate` (ADR-0009) renders a short clip from a still. The natural next workflow is to *chain*
clips — animate, take the last frame, animate again — and join the pieces into one longer video. The
test UI already extracts a clip's last frame client-side to continue a sequence; what's missing is a
way to concatenate the resulting clips into a single file.

Every clip `/animate` produces comes from the same ComfyUI `SaveVideo` node: **H.264, identical
resolution/fps, no audio**. That makes joining them a **stream copy** — no re-encode, no quality loss,
near-instant — which `ffmpeg`'s concat demuxer does directly (`-c copy`). The alternative, stitching
in the browser (canvas + MediaRecorder, or `ffmpeg.wasm`), either re-encodes with quality loss and
webm output, or pulls in a multi-megabyte WASM dependency that breaks the UI's self-contained,
no-build, no-deps design. Server-side `ffmpeg` is the clean fit.

The service already shells out to a system binary elsewhere (`scripts/fetch-wan22-models.ts` → `curl`),
so invoking `ffmpeg` via `child_process` is consistent — it is **not** a new npm/runtime dependency
(the "no runtime deps beyond tsx/typescript" invariant is about package.json, not system tools).

## Decision

### `POST /stitch` → `video/mp4`
JSON in, joined **mp4 bytes** out (200/422/503), auth-gated like `/generate` and `/animate`.

```jsonc
{ "clips": ["<base64 mp4>", "<base64 mp4>", ...] }   // 2–50 clips, in play order
```

The service is stateless (ADR-0001: it returns bytes and never saves), so it does not retain the clips
it rendered — the client holds them and uploads them back to `/stitch`. Because clips are mp4 (large),
`/stitch` uses a **larger request-body cap** (256 MB) than the image routes' 16 MB, via a per-route
`maxBytes` on `readBody`.

### Engine: `src/stitch.ts`
A small, ComfyUI-independent module (kept out of `engine.ts`):
- `stitchVideos(clips: Buffer[], opts?)` — writes the clips to a unique temp dir, writes an `ffmpeg`
  concat list, runs `ffmpeg -y -f concat -safe 0 -i list.txt -c copy out.mp4`, returns the output
  bytes, and cleans up the temp dir in a `finally`. **Never throws.** `ffmpeg` missing → a clean error
  (mapped to 503); non-zero exit → the error with the `ffmpeg` stderr tail.
- `ffmpegAvailable(opts?)` — a quick `ffmpeg -version` probe, so `/health` can advertise availability.
- The `ffmpeg` invocation is **injectable** (an `opts.run` function, defaulting to a real
  `child_process.spawn`) so unit tests drive success / failure / missing-binary paths with **no
  `ffmpeg` and no filesystem race** — mirroring how the engine injects `fetch`.

`-c copy` assumes the clips share codec/resolution/fps, which they do when they come from `/animate`.
Mixed-size clips would make `ffmpeg` fail; that surfaces as a clear 503 rather than a silent bad file.
Re-encoding to a common size is a possible future upgrade, deliberately not taken for v1.

### Server + health
- `POST /stitch` validated by `parseStitchBody` (a `clips` array of 2–50 non-empty strings → 422
  otherwise); an over-cap body returns **413**.
- `createServer` gains an optional third `deps` argument (`{ stitchVideos?, ffmpegAvailable? }`,
  defaulting to the real implementations) so tests inject a fake stitcher and the 200 path is covered
  CI-safe.
- `/health` gains **`stitch: { available }`** from `ffmpegAvailable`, so the UI can disable the stitch
  button with a reason when `ffmpeg` isn't installed.

### UI (test harness)
A **Sequence** panel: an "➕ Add to sequence" button appears under each rendered clip; the panel lists
the queued clips in order (remove / move up-down), and **Stitch & download** POSTs them to `/stitch`
and hands back the combined mp4. Together with the existing "Continue from last frame", this is the
full loop: animate → continue → add → stitch.

## Consequences
- **Lossless and fast** — `-c copy`, no re-encode. A join of same-settings clips is near-instant.
- **`ffmpeg` is required on the host** for `/stitch` (already present alongside ComfyUI). Absent →
  clean 503 + `/health` `stitch.available:false`; nothing else is affected.
- **Clips must share resolution/fps** (guaranteed by `/animate` defaults). Mixed sizes → 503, not a
  broken file. Re-encode-to-common-size is a future option.
- **Large request bodies** (mp4 upload) — 256 MB cap on this route only; other routes unchanged.
- **Stateless preserved** — the service still saves nothing; clips round-trip from the client.
- Additive: no change to `/generate`, `/animate`, the engine, or the SDXL/Wan paths.
