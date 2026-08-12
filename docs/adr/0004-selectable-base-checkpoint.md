# ADR-0004: Selectable base checkpoint

## Status
Accepted

## Context
The SDXL base checkpoint was hardcoded as `sd_xl_base_1.0.safetensors` in both workflow templates
(`src/workflows/sdxl-txt2img.json` and `sdxl-refiner.json`, node `"4"`). The base checkpoint is the
single largest determinant of the output's character — the style LoRAs only nudge within whatever the
base model can already render. Operators who install other SDXL checkpoints in ComfyUI
(`models/checkpoints/`) had no way to select one short of editing the workflow JSON by hand.

We want the base checkpoint to be selectable both as a service-wide default and per request, without
touching the workflow files, and without the service needing to know anything about which models are
installed.

## Decision
Make the base checkpoint configurable with the precedence **per-request `checkpoint` >
`config.comfyui.checkpoint` > workflow template default**:

- **Config:** add `comfyui.checkpoint` (string, default `""`). Empty means "keep the workflow
  template's checkpoint", so existing deployments are unaffected.
- **Per-request:** `POST /generate` accepts an optional `checkpoint` field. The server validates it
  lightly (non-empty string, ≤ 200 chars, no `..`, backslash, NUL, or leading `/`) and otherwise
  defers to ComfyUI, which is the authority on which checkpoints exist.
- **Engine:** a `setNodeCheckpoint` helper overrides node `"4"`'s `ckpt_name` on the cloned graph
  when a checkpoint is set. It composes with the existing LoRA (node `"20"`) and IP-Adapter chains,
  which take the model/clip from node `"4"`.
- **Discovery:** `/health` reports the list of checkpoints ComfyUI can load and the effective default
  checkpoint, so a client (including the built-in test UI) can present a picker.

An unknown checkpoint name is not pre-validated by the service: ComfyUI rejects it as `node_errors`
on `POST /prompt`, which the engine already surfaces as a clean `{ ok: false, error }` → HTTP 503.
This reuses existing behavior rather than adding a second source of truth.

## Consequences
- Backward-compatible: with no config value and no request field, behavior is identical (stock
  `sd_xl_base_1.0.safetensors`).
- Only the **base** checkpoint (node `"4"`) is overridden. The refiner checkpoint (node `"11"`, used
  only at `quality=high`) stays stock SDXL refiner; a base checkpoint that is not paired with the
  SDXL refiner is best used at `fast`/`standard` quality. Making the refiner selectable is deferred
  until there is a need.
- The service never ships, bundles, or names any model — it only lists and selects what ComfyUI
  already has installed. Installing model weights remains a manual ComfyUI-side step.
- Unrelated but worth restating from ADR-0002: auth is off by default and the server binds
  `0.0.0.0`. Operators exposing the service beyond a trusted machine should enable the token gate or
  bind to `127.0.0.1`.
