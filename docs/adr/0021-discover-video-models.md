# ADR-0021: Discover image-to-video models live; keep model names out of the repo

## Status

Accepted

## Context

`/animate` selected its diffusion model from a **fixed registry** hardcoded in the source
(`src/video-models.ts` + the model filenames baked into `src/wan-workflow.ts` and the workflow JSON).
Two problems followed:

1. **A model the user installs never appears.** The test-UI video dropdown was two literal `<option>`
   tags. Dropping a new image-to-video model into ComfyUI's `models/diffusion_models/` (including in
   an a subfolder, per ADR-0017/0019) could never surface it — the service only knew the
   names compiled into it.
2. **Model filenames live in the repo.** Adding a model meant committing its filename. That is
   unacceptable for private/experimental models: the repo must never contain a model name that hints
   at a model's content. The swappable model is exactly the thing that must not be named in source.

ComfyUI already knows what is installed and exposes it through `/object_info`. Diffusion models are
advertised under two loader nodes depending on format:

- `.safetensors` → `UNETLoader.unet_name`
- `.gguf` → `UnetLoaderGGUF.unet_name` (the ComfyUI-GGUF custom node)

The text encoder and VAE are shared Wan infrastructure (public, content-neutral files) and stay
referenced as before; they are not the swappable model and carry no content signal.

## Decision

Select the video diffusion model **from ComfyUI's live inventory**, never from a compiled-in name.

- **Discovery** — `listDiffusionModels(base, fetchFn)` (engine) returns every installed diffusion
  model as `{ name, loaderClass }`, unioning `UNETLoader` and `UnetLoaderGGUF`. Names are whatever
  ComfyUI reports (with any a subfolder prefix), read at request time and never persisted.
- **Dropdown** — `GET /health` gains `videoModels` (the discovered names). The UI builds the video
  Model picker from it, grouped by subfolder and showing clean basenames — mirroring the checkpoint
  picker (ADR-0019). No `<option>` is hardcoded.
- **Selection** — `POST /animate` accepts `diffusionModel` (the exact ComfyUI name; path-safety
  validated, the a subfolder prefix allowed). Absent → the engine uses the first discovered model, so
  a single-model host needs no field. `model` is still accepted for the legacy registry path
  (e.g. LTX-Video), unchanged.
- **Loader by format** — `animateImage` renders the Wan i2v graph, then sets the diffusion-loader
  node to `UnetLoaderGGUF` for a `.gguf` file or `UNETLoader` otherwise, injecting the exact name.
  The text-encoder and VAE nodes keep basename reconciliation (ADR-0020). Preflight now checks the
  shared infra is present and that at least one diffusion model exists — a missing model yields a
  clean, **name-free** error ("add a model to `models/diffusion_models/` and restart ComfyUI").
- **No model name in the repo.** The workflow template and code no longer depend on a specific
  diffusion-model filename; the name flows from ComfyUI → `/health` → browser at runtime only. Tests
  use neutral placeholder names.

## Consequences

- Any installed image-to-video model — `.safetensors` or `.gguf`, on either drive, in any named
  subfolder — shows up in the dropdown and animates, with nothing about it committed to the repo.
- The `wan-5b` registry entry's diffusion filename is no longer authoritative for the default path
  (kept only for the smoke script / back-compat); the Wan path is always dynamic.
- A few extra best-effort `/object_info` probes per animate + health request against the local
  ComfyUI. Failures degrade to "nothing installed", handled cleanly.
- Operational reminder (ADR-0017): ComfyUI only indexes a drive mounted when it starts; restart
  ComfyUI after adding files. Outside this service.
