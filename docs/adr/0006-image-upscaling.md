# ADR-0006: Image upscaling

## Status
Accepted

## Context
Generated images come out at SDXL's native resolution (~1024²). Asking the sampler for much larger
sizes makes SDXL duplicate/warp, so the reliable way to get a large, sharp image is to **upscale the
finished image** with a trained super-resolution model (ESRGAN family) as a post-process. The engine
already assembles a graph that ends `VAEDecode "8" → SaveImage "9"` in both workflows, so an upscale
tail slots in cleanly and composes with everything (txt2img, img2img, style, checkpoint, refiner).

## Decision
Add two optional `POST /generate` params:

- **`upscale`** — target factor in `(1, 4]` (e.g. `2`, `4`). Presence enables upscaling.
- **`upscaleModel`** — which upscale model (as ComfyUI lists it). Precedence: **request >
  `config.comfyui.upscaleModel` > the first installed model**.

Engine (`src/engine.ts`), `applyUpscale(graph, modelName, factor)` — inserted as the **last** graph
mutation, between nodes `"8"` and `"9"`:
- `UpscaleModelLoader "40"` → `ImageUpscaleWithModel "41"` (image `["8",0]`) runs the model at its
  native factor.
- If `factor !== native`, `ImageScaleBy "42"` (`upscale_method:"lanczos"`, `scale_by: factor/native`)
  trims to the exact factor. `ImageScaleBy` is **relative**, so it needs no absolute dimensions —
  which matters because in img2img the service never computes the output's pixel size.
- `SaveImage "9"` is repointed at the final node. Node ids 40–42 are otherwise unused, so upscale
  composes with the LoRA (`"20"`), IP-Adapter (`"21"–"25"`), and img2img (`"30"–"31"`) nodes.
- The model's **native factor** is parsed from its filename (`4x-UltraSharp`, `RealESRGAN_x4plus` →
  4), defaulting to 4 when unparseable — the standard "upscale to 4×, scale to target" pattern.

Server (`src/server.ts`): `parseGenerateBody` validates `upscale` (`(1,4]`) and `upscaleModel` (light
path-safety) → 422; `handleGenerate` fills the config-default model like it does for `checkpoint`;
`/health` reports `upscaleModels` (installed list) and the effective `upscaleModel`. `probeComfy`
gains a best-effort `listUpscaleModels` probe.

## Consequences
- **Output size = generated size × factor.** A 4× on 1024² is 4096².
- **No model installed → clean 503** ("add one to `models/upscale_models/`"), rather than silently
  skipping — the caller explicitly asked to upscale. (Contrast: the IP-Adapter reference path
  degrades to prompt-only, because a reference is an enhancement.)
- The tier timeout is extended (~60 s) when upscaling, since a 4× pass on a large plate takes longer.
- Backward-compatible: without `upscale`, behavior is unchanged.
- This is **pure super-resolution** — it sharpens/enlarges existing pixels. A "hires fix" that
  re-diffuses to *invent* new detail (latent upscale + a second sampler pass) is a separate future
  mode, out of scope here. Tiled upscaling for very large targets is also future work.
