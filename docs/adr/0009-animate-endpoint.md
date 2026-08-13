# ADR-0009: POST /animate endpoint

## Status
Accepted

## Context
ADR-0008 stood up the Wan 2.2 TI2V 5B image-to-video pipeline and proved it end-to-end outside the
service (`scripts/smoke-wan22.ts` + `src/wan-workflow.ts`'s `renderWanWorkflow`). This cycle exposes
it through the service as **`POST /animate`**: hand it a still image and a prompt, get back a short
video.

The pipeline is done; the decisions here are about the **HTTP contract** — how the request looks,
what the response is, how failures map to status codes, and how a multi-minute render fits a service
whose other endpoint (`/generate`) returns in seconds.

## Decision

### Synchronous, returns video bytes — mirroring /generate
`/generate` takes JSON in and returns raw PNG bytes synchronously (200/422/503). `/animate` follows
the same shape: JSON in, **raw video bytes out** (`Content-Type: video/mp4`), status 200/422/503. No
job id, no polling, no async queue. The service is a thin, single-user-on-the-LAN front for ComfyUI;
a synchronous request that the caller waits on is the established contract, and matching it keeps the
client story identical to `/generate` (POST, read the bytes, save them — the service never saves).

The cost is an **HTTP connection held open for minutes** per render. That is acceptable for this
service's deployment (trusted LAN, low concurrency; ComfyUI already serializes GPU work). An async
job API is noted as a **future** option if batch/concurrent animation ever becomes a real workload —
it is not warranted now and would double the surface area for no current benefit.

### Request body
```jsonc
{
  "image":  "<base64 still, required>",   // the picture to animate
  "prompt": "<text, required>",           // how it should move
  "negativePrompt": "<text>",             // appended to the Wan baseline negative
  "seed": 123,
  "width": 1280, "height": 704,           // target video resolution (engine snaps to /32)
  "frames": 121,                          // 1..121 (cap = 5s @ 24fps)
  "fps": 24                               // 1..120
}
```
`image` + `prompt` are required; everything else is optional and defaults per ADR-0008 (1280×704,
24 fps, 121 frames). Validation lives in `parseAnimateBody` (a 422 with a specific message on any bad
field), exactly like `parseGenerateBody`. `width`/`height` are validated as integers in
`[256, 2048]`; the engine snaps them to Wan's multiple-of-32 grid and `frames` to the `4k+1` grid, so
the boundary stays lenient and the engine owns the grid math (single source of truth —
`renderWanWorkflow`).

### Engine: `animateImage`, parallel to `generateImage`
`src/engine.ts` gains `animateImage(comfyUrl, params, fetchFn)` returning
`{ ok: true, bytes, contentType, filename } | { ok: false, error }`. It **never throws** and reuses
the existing in-module transport helpers (`comfyBase`, `uploadImage`, the POST /prompt → poll
/history-by-own-prompt_id → /view dance). **`generateImage` is not touched** — the image path has
zero regression risk; the video path is additive and lives beside it.

Two differences from the image path:
- **Preflight model check.** Unlike the IP-Adapter reference path (which *degrades* to prompt-only
  when its model is absent), animation **cannot** proceed without the three Wan files. `animateImage`
  checks `/object_info` for them up front and returns a clean error naming exactly what is missing and
  pointing at `scripts/fetch-wan22-models.ts`. The server maps that to **503**.
- **Video-tier timeout.** A 5 s / 121-frame 5B render takes minutes, and the **first** animation after
  an image job (or vice-versa) also pays the one-time **SDXL↔Wan model-load pause** (ADR-0008) as the
  12 GB card swaps model sets. The poll budget is therefore **20 minutes** (`ANIMATE_TIMEOUT_MS`),
  far above the image tiers' 2–5 min, and the final `/view` download uses a longer per-request timeout
  (a multi-MB mp4 does not fit the 30 s image budget).

The output-node scan is generalized: Wan ends in `SaveVideo`, whose history output key varies by
ComfyUI build, so the poll loop takes the first output file with a `filename` rather than assuming an
`images` array under a fixed node id.

### Server + health
- `POST /animate` is **auth-gated** exactly like `/generate` (bare 401 when the shared token is
  enabled and missing/wrong). `/health` stays ungated.
- `/health` gains a **`wan`** block — `{ ready: boolean, missing: string[] }` — so a client can tell
  whether animation is available before trying, the same way it reports `lorasLoaded` /
  `upscaleModels`. Best-effort: an unreachable ComfyUI reports `ready: false`.

## Consequences
- **A new capability with a new media type.** `/animate` returns `video/mp4`; existing image callers
  are unaffected.
- **Long-held connections.** A render occupies a connection for minutes; clients must set a generous
  read timeout. Documented in the developer reference.
- **No async/job API** — deliberately. Revisit only if concurrent/batch animation becomes real.
- **The model-load pause is real and user-visible** on the first job after a type flip; the 20-minute
  budget absorbs it rather than surfacing a spurious timeout.
- **Zero image-generation regression:** `generateImage`, the SDXL templates, and the `/generate`
  validation path are unchanged; `/animate` is purely additive.
- **14B-GGUF quality tier** remains a future upgrade (ADR-0008); this endpoint is 5B-only for now.
