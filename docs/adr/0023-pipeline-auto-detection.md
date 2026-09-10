# ADR-0023: Auto-detect a video model's pipeline from its file header

## Status

Accepted

## Context

ADR-0022 gave the service three video pipelines (Wan 2.2 TI2V, Wan 2.1 I2V, Wan T2V) selected by an
explicit `pipeline` field. That works but pushes an architecture decision onto the user, and model
NAMES are unreliable signals — e.g. a `wan22Enhanced…` GGUF is actually a 36-channel Wan 2.1 **i2v**
model, not a "2.2" anything. Picking the wrong pipeline yields a runtime tensor mismatch (ADR-0022's
translated error).

The reliable signal is the model's latent (patch-embedding **in-**)channel count, which is right there
in the file header: **48 → Wan 2.2 TI2V, 36 → Wan 2.1 I2V, 16 → Wan T2V**. ComfyUI is local (ADR-0001),
so the service can read the file — it just needs to know which directory the ComfyUI-reported name
(e.g. `ns/foo.gguf`) lives under.

## Decision

Detect the pipeline by reading the model file header, and let the UI pre-select it.

- **`src/model-arch.ts`** (pure, never-throw): `detectLatentChannels(file)` reads the
  `patch_embedding.weight` shape from a **safetensors** header (`shape[1]` = in_channels) or a
  **GGUF** header (city96 ComfyUI-GGUF; dims are ggml-reversed, so in_channels is `dims[-2]`).
  `pipelineForChannels` maps 48/36/16 to a pipeline. `resolveModelFile(name, dirs)` finds the name
  under the configured roots (rejecting traversal). `detectPipeline(name, dirs)` ties them together.
- **Config** gains `comfyui.diffusionModelDirs` (the local `diffusion_models/` roots, one per drive).
  Empty ⇒ auto-detection is off and the caller's explicit `pipeline` stands. `config.json` is
  gitignored, so a user's drive paths never enter the repo.
- **`GET /detect-pipeline?model=<exact name>`** returns `{ pipeline, channels }`, or
  `{ pipeline: null, reason }` when it can't tell (dirs unset, file not found, unknown format). Gated
  like `/checkpoints`; never throws.
- **UI**: choosing a model calls the endpoint and pre-selects the matching pipeline (with a visible
  "Auto-selected … (N-channel)" note); the user can still override. Best-effort — if detection is
  unavailable the manual dropdown is unchanged.

Detection only *reads* the file; it never decides what runs on its own — the request still carries an
explicit pipeline, so the engine (ADR-0022) is unchanged and a remote-ComfyUI deployment (no local
files, dirs unset) simply keeps manual selection.

## Consequences

- Models "just work": pick the model, the right pipeline is chosen for you — no architecture knowledge
  needed, and no more silent wrong-pipeline tensor errors for a mislabeled model.
- Verified end-to-end on real files: `wan2.2_ti2v_5B` → 48/ti2v, `lightx2v…i2v` → 36/i2v,
  `rapidWAN…T2V` → 16/t2v.
- Adds one local file-header read per model selection (a few KB); failures degrade to manual.
- Opt-in via config: unset `diffusionModelDirs` ⇒ exactly the ADR-0022 behavior.
