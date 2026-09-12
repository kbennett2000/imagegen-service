# ADR-0024: Record the producing model in the output filename

## Status

Accepted

## Context

When a user experiments across many models — the whole point of the discovery + auto-detection work
(ADR-0021/0023) — a folder of outputs loses track of *which model made which file*. The one fact worth
stamping into the name is the model that produced it.

The filename that actually lands on disk is written by ComfyUI's `SaveImage`/`SaveVideo` node, which
names the file `<filename_prefix>_<counter>_.<ext>` (e.g. `imagegen_00042_.png`,
`imagegen-wan_00042_.mp4`). The service only ever set a static prefix, so every render reused the same
base name. (A first attempt tagged only the HTTP download name via `Content-Disposition` — but that
never touches the file ComfyUI writes, which is the filename the user actually sees.)

## Decision

Tag the `filename_prefix` of every save node with the producing model, so ComfyUI writes the model
into the on-disk file: `imagegen` → `imagegen.dreamshaper_8`, producing
`imagegen.dreamshaper_8_00042_.png`.

- **Engine** (`tagSaveNodesWithModel`, pure/total): for each `SaveImage`/`SaveVideo` node in the graph,
  appends `.` + the model segment to its `filename_prefix`. The segment is the model's basename with
  any subfolder prefix (`ns/…`) and weight-file extension (`.safetensors`/`.gguf`/…) stripped, and
  filesystem-unsafe characters mapped to `_`; dots inside the name are kept (`wan2.2_ti2v_5B`). An
  unknown model or a graph with no save node is a no-op.
  - Image path tags with the resolved `checkpoint` (or the template default `sd_xl_base_1.0`).
  - Video path tags with the diffusion model the plan chose (`AnimationPlan.model`) — the discovered
    Wan model on the dynamic paths, the model id on the legacy registry path.
- **Response name** (complementary): `/generate` and `/animate` now pass ComfyUI's produced filename
  back and send `Content-Disposition: inline; filename="<name>"`, so a browser "save" or `curl -OJ`
  matches the on-disk name. `GenerateResult` gains `filename`. `inline` keeps the UI's in-page preview;
  the value is stripped of quotes/CR/LF defensively.
- **UI**: the image result gains a download link, and both image and video links read the suggested
  name from `Content-Disposition` (generic fallback if absent).

No model NAMES enter the repo (ADR-0021 invariant): the tag is computed at runtime from the model the
caller/ComfyUI already named; tests use neutral placeholders.

## Consequences

- The on-disk file records its model (`imagegen.dreamshaper_8_00042_.png`,
  `imagegen-wan.wan2.2_ti2v_5B_fp16_00042_.mp4`), so a folder of experiment outputs is
  self-describing. ComfyUI's `_<counter>_` still sits between the model and the extension — that's its
  fixed anti-overwrite counter, not something the service controls.
- Additive: existing callers are unaffected; the bytes and content-type are unchanged.
- Best-effort: an unknown model leaves the prefix untagged rather than failing a render.
