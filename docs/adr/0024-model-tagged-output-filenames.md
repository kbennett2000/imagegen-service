# ADR-0024: Record the producing model in the output filename

## Status

Accepted

## Context

`/generate` and `/animate` return raw bytes (the service saves nothing — callers do, per ADR-0001).
Until now the response carried no suggested filename at all: the browser UI hard-coded generic names
(`animated.mp4`) and images had no download link. When a user experiments across many models — the
whole point of the discovery + auto-detection work (ADR-0021/0023) — a folder of `ComfyUI_00042_.png`
files loses track of *which model made which output*. The one fact worth stamping into the name is the
model that produced the file.

## Decision

Tag the output filename with the producing model — `filename.extension` → `filename.model.extension` —
and surface it to the caller.

- **Engine** (`tagFilenameWithModel`, pure/total): inserts the model as a segment before the
  extension. The segment is the model's basename with any subfolder prefix (`ns/…`) and weight-file
  extension (`.safetensors`/`.gguf`/…) stripped, and filesystem-unsafe characters mapped to `_`; dots
  inside the name are kept (`wan2.2_ti2v_5B`). An unknown model is a no-op.
  - Image path: tagged with the resolved `checkpoint` (or the template default `sd_xl_base_1.0`).
    `GenerateResult` gains `filename`.
  - Video path: tagged with the diffusion model the plan chose (`AnimationPlan.model`) — the
    discovered Wan model on the dynamic paths, the model id on the legacy registry path.
- **Server**: `/generate` and `/animate` now send
  `Content-Disposition: inline; filename="<tagged>"`. `inline` keeps the UI's in-page preview while
  giving browsers and `curl -OJ` the name on save; the value is stripped of quotes/CR/LF defensively.
- **UI**: the image result gains a download link, and both image and video links read the suggested
  name from `Content-Disposition` (falling back to a generic name if absent).

No model NAMES enter the repo (ADR-0021 invariant holds): the tag is computed at runtime from the
model the caller/ComfyUI already named; tests use neutral placeholders.

## Consequences

- A saved file records its model (`ComfyUI_00042_.dreamshaper_8.png`,
  `clip.wan2.2_ti2v_5B_fp16.mp4`), so a folder of experiment outputs is self-describing.
- The response is additive — existing callers that ignore `Content-Disposition` are unaffected; the
  bytes and content-type are unchanged.
- The tag is best-effort: an unknown model leaves the name untagged rather than failing a render.
