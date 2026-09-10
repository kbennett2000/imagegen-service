# ADR-0020: Reconcile video-model files by basename (subfolder tolerance)

## Status

Accepted

## Context

ADR-0019 taught the **image** path to tolerate subfoldered checkpoints: ComfyUI lists each model
file relative to whichever configured root it was found under, so the same file reads as
`foo.safetensors` at a root and `sub/foo.safetensors` in a subfolder of one (most naturally a named subfolder on a drive — ADR-0017). Checkpoints now reconcile bare
catalog/template names against ComfyUI's reported names **by basename**, so a subfoldered install
still reads installed and still loads.

The **video** path (ADR-0009 Wan 2.2, generalized to a registry in ADR-0015) never got this. Its
model files are referenced by **bare** filename in two places:

1. **Preflight** — `videoModelsMissing` (`src/engine.ts`) tests presence with exact string equality
   (`options.includes(f.file)`), so a file ComfyUI reports as `sub/wan2.2_ti2v_5B_fp16.safetensors`
   reads as **not installed** even though it is present.
2. **Injection** — the per-model workflow renderers (`renderWanWorkflow`, `renderLtxvWorkflow`) bake
   the bare filename into the loader nodes (`UNETLoader.unet_name`, `CLIPLoader.clip_name`,
   `VAELoader.vae_name`, `CheckpointLoaderSimple.ckpt_name`). Even if a subfoldered file were somehow
   accepted, ComfyUI would reject the load because the graph asks for the unprefixed name.

Concretely: a Wan file at a `diffusion_models` root works, but move it into `diffusion_models/s/`
(the same organization the checkpoint side supports) and `/animate` reports "model files not
installed" and `/health` reads `wan.ready: false`. The user's goal is symmetry with image models:
keep video models on either drive and in subfolders, and have the *supported* models
still be recognized and loadable.

Scope note — this is about the **supported** models (the registry in `src/video-models.ts`:
`wan-5b`, `ltxv`). Unlike interchangeable SDXL checkpoints under one workflow, each video model needs
its own workflow graph, so the service only runs models it has a renderer for. This ADR does not add
a "list installed video files" picker; it makes the curated set drive-/subfolder-agnostic.

## Decision

Reuse ADR-0019's basename reconciliation for the video path — no new logic, just applied where the
video code referenced bare names.

- **`src/checkpoints.ts`** exposes the three pure helpers under generic aliases, since the basename
  logic is not checkpoint-specific — it works for any ComfyUI model dir (`diffusion_models`,
  `text_encoders`, `vae`, `checkpoints`): `modelBasename`, `modelInstalled`, `reconcileModelName`
  (aliases of `checkpointBasename` / `checkpointInstalled` / `reconcileCheckpoint`).
- **`videoModelsMissing`** tests presence with `modelInstalled(f.file, options)` (basename match)
  instead of exact equality. The returned "what to fetch" list still names `<subdir>/<bare-file>` so
  the actionable message is unchanged.
- **`animateImage`**, after rendering the graph, reconciles every loader node whose
  `class_type`/input matches a spec file against ComfyUI's live `object_info` list, rewriting the
  input to the exact name ComfyUI advertises (recovering a subfolder prefix) — mirroring how
  `generateImage` already reconciles `CheckpointLoaderSimple` nodes (ADR-0019). A truly absent file
  is left unchanged so ComfyUI still returns its own clean "not found".

The workflow renderers stay **pure** (no network) and keep emitting bare names; reconciliation lives
in the engine where the live list is available, exactly as on the image path.

## Consequences

- The supported video models (`wan-5b`, `ltxv`) are recognized and load from either drive and from
  subfolders, matching the checkpoint experience. Flat layouts keep working (exact match
  wins before basename fallback).
- No change to the `/animate` API, the dropdown (still the fixed registry), or the renderers'
  signatures. Reconciliation adds a few best-effort `object_info` probes per animate request against
  the local ComfyUI; failures degrade to the bare name (ComfyUI then reports not-found as before).
- Operational reminder (unchanged from ADR-0017/0019): ComfyUI only indexes drives listed in
  `extra_model_paths.yaml` that are mounted **when ComfyUI starts**; restart ComfyUI after adding
  files. That is outside this service.
