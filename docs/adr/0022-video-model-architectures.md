# ADR-0022: Multiple video-model architectures — workflow registry + honest gating

## Status

Proposed (Phase 0 landed: honest error translation; Phases 1+ are the roadmap below)

## Context

ADR-0021 made `/animate` select any installed diffusion model from ComfyUI's live inventory. In
practice a user's `models/diffusion_models/` holds models from **several incompatible architectures**,
and the service ships a **single** workflow (Wan 2.2 TI2V 5B). Feeding a non-matching model into it
fails inside ComfyUI at the sampler — e.g. `The size of tensor a (48) must match the size of tensor b
(16)`: the model expects a different latent-channel count than the Wan 2.2 VAE produces.

The differences are fundamental — different latent channels, VAE, text encoder, sometimes a
CLIP-vision model, and a different node graph. Observed on one machine (patch-embedding `in_channels`
read from the file header):

| Model (example) | latent ch | Family / task | Needs |
| --- | --- | --- | --- |
| `wan2.2_ti2v_5B_fp16` | 48 | Wan 2.2 TI2V (i2v+t2v) | `wan2.2_vae`, umt5 |
| `wan22T2vLowNoise14B` | 16 | Wan 2.2 T2V (text→video) | `wan_2.1_vae`, umt5, no input image |
| `wan21NF4_i2v14B` | 36 | Wan 2.1 I2V | `wan_2.1_vae`, umt5, CLIP-vision, `WanImageToVideo` |
| Hunyuan / SkyReels | — | separate families | own VAE/encoder/graph |

So "list every diffusion model as animatable" (ADR-0021) over-promises: only 48-channel Wan 2.2 TI2V
models actually run. A second constraint is VRAM — on a 12 GB card, 14B fp16 models don't fit at all
(GGUF-Q4/fp8 required), which bounds what is even runnable regardless of workflow.

## Decision

Make the service **workflow-driven and architecture-aware** rather than hardcoding one graph.

- **Workflow registry.** A set of workflow templates, each tagged with the architecture it serves
  (latent channels, task = i2v/t2v, model family) and the roles it needs (diffusion loader kind, VAE,
  text encoder, CLIP-vision). Adding a family = drop in a template + a detector rule; no core change.
- **Architecture detection.** Determine each installed model's architecture — read the file header
  where the service can (ComfyUI is local per the project spec: safetensors `patch_embedding`
  `in_channels`; GGUF metadata), else fall back to a declared mapping. Detection keys a model to a
  compatible template and the correct VAE.
- **Role-based auto-wiring.** Fill the template's VAE / text-encoder / CLIP-vision from what ComfyUI
  actually has installed (by role), so a model runs without any name hardcoded (continues ADR-0021).
- **Honest gating.** The picker offers only models a template can run; the rest are shown as
  "installed, unsupported architecture" (disabled) rather than silently failing. A tensor-mismatch
  execution error is translated to a plain message (Phase 0), never a raw `RuntimeError`.

### Phased roadmap (each phase GPU-verified before it ships)

0. **Honest errors (landed).** `formatVideoExecutionError` translates a sampler tensor-size mismatch
   into "this model needs a workflow the service doesn't have yet". No more raw tensor crash.
1. **Wan 2.1 I2V (GGUF-first).** Highest coverage-per-effort and fits 12 GB: new i2v template
   (CLIP-vision + `WanImageToVideo` + `wan_2.1_vae`), architecture detection + routing, role wiring.
   Unlocks the quantized Wan 2.1 i2v models.
2. **Wan T2V (text→video).** No input image — a distinct request shape / UI flow for the T2V models.
3. **Hunyuan / SkyReels.** Separate families, their own templates; largest and most open-ended.

## Consequences

- The tool stops lying: it runs what it can and clearly explains what it can't, per model.
- Coverage grows by adding templates, not rewriting the engine.
- VRAM still bounds the runnable set (documented per phase); the service reports ComfyUI's OOM as-is.
- Detection reads local model files — acceptable under the local-ComfyUI assumption; a remote ComfyUI
  would need a declared architecture mapping in config instead (future).
