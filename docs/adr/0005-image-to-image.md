# ADR-0005: Image-to-image (init image + prompt)

## Status
Accepted

## Context
The service was text-to-image only: every render's latent came from an `EmptyLatentImage` node, so
generation always started from pure noise. A common need is **img2img** — supply an input image as
the *starting point* and let the prompt transform it (restyle a photo, iterate on an existing image,
"apply this prompt to this picture"). The engine already has the transport for it (it uploads base64
images to ComfyUI for the IP-Adapter reference feature), so this is a small, contained addition.

This is deliberately distinct from the existing **`references`** (IP-Adapter) feature: that
conditions a *freshly generated* scene on a subject's likeness (a face/character), and does **not**
use the input as starting pixels. img2img uses the input image's actual pixels as the canvas.

## Decision
Add two optional `POST /generate` params:

- **`initImage`** — a base64 PNG. Its presence switches the request to img2img.
- **`denoise`** — number in `(0, 1]`, default **0.65**. The single img2img knob: `0` ≈ returns the
  input, `1` ≈ ignores it (pure txt2img). Named `denoise` (the ComfyUI term) rather than a
  "strength" to avoid inverse-semantics confusion with `referenceStrength`.

Engine (`src/engine.ts`):
- `applyImg2Img(graph, imageName, denoise)` injects `LoadImage("30") → VAEEncode("31")` (using the
  workflow's existing `VAELoader "10"`), repoints the base sampler `"3"` `latent_image` to
  `["31",0]`, and sets its `denoise`. Node ids 30/31 avoid the LoRA (`"20"`) and IP-Adapter
  (`"21"–"24"`) ranges, so img2img **composes** with style LoRAs, checkpoint overrides, and even the
  reference/IP-Adapter path.
- The base64→ComfyUI uploader (`uploadReference`) is renamed **`uploadImage`** and reused.
- img2img **forces the base workflow** even at `quality:"high"` (the refiner graph has a different
  node shape), mirroring the existing `references`/`noRefiner` rule.

Server (`src/server.ts`): `parseGenerateBody` validates `initImage` (non-empty string) and `denoise`
(`(0,1]`), else 422.

UI (`src/ui.html`): a "Starting image (img2img)" file picker + a "Change amount" (denoise) slider,
plus — surfacing the pre-existing params — a "Reference photo" picker + "Likeness strength" slider.
Chosen images are downscaled client-side to ≤1024px on the long edge before upload.

## Consequences
- **Output size follows the input image** in img2img mode; `width`/`height` are ignored (the sampler
  reads the encoded latent, not `EmptyLatentImage`). Documented, not an error.
- **A failed upload fails the request cleanly (503)** rather than silently degrading to txt2img —
  silently ignoring the caller's image would return an unrelated picture. This intentionally differs
  from `references`, which degrades to prompt-only (a reference is an enhancement; an init image is
  the whole point of the request).
- No new ComfyUI nodes are required (`LoadImage`/`VAEEncode` are core), so no availability probe —
  unlike IP-Adapter.
- **High-resolution inputs** are the caller's responsibility for now: the UI downscales to ~1 MP, and
  API callers should send similarly sized images (huge inputs are slow, can OOM, or duplicate). A
  server-side `ImageScale` is a possible future add.
- Backward-compatible: without `initImage`, behavior is identical to before.
- Inpainting/masks, batched init images, and refiner-based img2img are out of scope.
