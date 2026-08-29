# ADR-0015: Multi-model video dispatch + LTX-Video

## Status
Accepted

## Context
`POST /animate` (ADR-0008/0009) was hardwired to one model, Wan 2.2 TI2V 5B: `animateImage` called
`wanModelsMissing` then `renderWanWorkflow` directly, and `AnimateParams` had no way to pick a model.
To offer a *variety* of SFW video models, `/animate` needs to dispatch across models by id, each
contributing its own required-file list and its own ComfyUI workflow, while the shared transport
(upload → POST /prompt → poll `/history` by own id → `/view`) and the never-throw / video-tier-timeout
discipline stay exactly as they are. This ADR adds a small model registry and a second model,
LTX-Video, as the concrete proof that the registry generalizes.

## Decision

### A table-driven video model registry
`src/video-models.ts` adds `VIDEO_MODELS`, a `Record<AnimateModel, VideoModelSpec>`. A spec carries
everything model-specific: `label`, the `files` to preflight (each with the object_info
`loaderClass`/`inputName` to probe and the `subdir`/`file` for the "what to fetch" message), a
`fetchHint` (the script named in that message), and a `render(params) → graph`. The module is pure
data + renderers and imports **no** engine code, so there is no import cycle
(`engine.ts → video-models.ts → *-workflow.ts`).

### `animateImage` dispatches; the transport is unchanged
`animateImage` resolves `spec = getVideoModel(params.model)`, preflights `spec.files` via a
generalized `videoModelsMissing(base, fetchFn, files)`, and renders via `spec.render(...)`. Everything
downstream — the upload, `/prompt` submit, per-own-id `/history` poll, `/view` fetch, the 20-minute
video timeout — is byte-for-byte what it was. `wanModelsMissing` stays exported (smoke script + tests)
as a thin wrapper over the generic check with the wan-5b file list. With no `model` in the request,
the default is `wan-5b`, so **existing callers are unaffected**.

### Validation at the edge
`parseAnimateBody` (server) rejects a `model` that isn't in `ANIMATE_MODELS` with a 422 naming the
valid ids; an accepted id flows through to the engine. Unknown models never reach ComfyUI.

### The second model: LTX-Video 2B
`src/ltxv-workflow.ts` + `src/workflows/ltxv-i2v.json` add LTX-Video (Lightricks) 2B, authored from
the canonical ComfyUI native LTXV image-to-video template: `CheckpointLoaderSimple` +
`CLIPLoader type=ltxv` (T5-XXL) → `LTXVImgToVideo` → `LTXVConditioning` → `LTXVScheduler` +
`KSamplerSelect` → `SamplerCustom` → `VAEDecode` → `CreateVideo`/`SaveVideo`. The renderer injects
prompt/image/seed/dims/fps by node id on a fresh clone per call (same purity guarantee as the Wan
renderer). LTX's grid differs from Wan's: dimensions snap to multiples of 32 and **frames to the 8n+1
lattice** (Wan is 4k+1); the shared server frame cap (121) is itself a valid 8n+1 value, so one input
bound serves both models and each renderer snaps onto its own lattice.

### Two files, fetched from ungated Hugging Face
The v0.9.5 2B checkpoint bundles its VAE, so LTX needs just two files: the checkpoint
(`models/checkpoints/`) and a separate T5-XXL text encoder (`models/text_encoders/`). Both are on
ungated HF, so `scripts/fetch-ltxv-models.ts` is a pure-HF fetcher reusing the wan script's tested
`planDownloads` (skip-by-exact-size) — no Civitai token needed. The fp8 T5 (~5.2 GB) + 2B checkpoint
(~6.3 GB) fit the 12 GB card comfortably.

### Model choice rationale
LTX-Video 2B v0.9.5 was picked as the second model because it is self-contained, fast, SFW/general,
fits 12 GB, and uses ComfyUI's native nodes with a well-documented canonical i2v template. Wan 2.2
**14B** was deferred: its high/low-noise dual-expert structure is a materially more complex graph.
The registry makes adding it (or any model) a matter of one spec + one template + one fetch script.

## Consequences
- **`/animate` is now multi-model** and extensible by table entry; Wan behavior is unchanged and the
  default, so no caller breaks.
- **Each model still needs its files on the box.** The preflight is per-model and fails cleanly and
  actionably (naming that model's fetch script) when they're absent — no silent degrade.
- **The LTX template is authored, not yet render-verified here.** Like the Wan foundation (ADR-0008),
  it can't be rendered on a box without the weights/nodes; node ids/classes/sampler settings come
  from the canonical ComfyUI template. A real-ComfyUI smoke check is the remaining validation step.
- **Timing knobs are shared for now.** The 20-minute animate timeout and the 121 frame cap cover both
  models; a fast LTX render finishes well inside them. Per-model tuning can follow if needed.
