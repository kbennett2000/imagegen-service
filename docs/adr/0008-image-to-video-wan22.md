# ADR-0008: Image-to-video via Wan 2.2 TI2V 5B

## Status
Accepted

## Context
The service generates still images by submitting parameterized SDXL workflow JSON to a local ComfyUI
instance (i7-9700KF, 64 GB RAM, RTX 5070 with **12 GB VRAM**). We want to animate an image the
service already produced: image-to-video (i2v).

This ADR covers the **foundation** — proving the Wan pipeline outside the service against the same
ComfyUI instance. A later cycle adds a `POST /animate` endpoint; nothing here touches existing
endpoints, SDXL templates, or job-handling code.

### Model choice: 5B now, 14B-GGUF later
Wan 2.2 ships in two sizes relevant to us:

- **TI2V 5B** — a single ~10 GB model that runs at **fp16** and fits 12 GB VRAM with the umt5-xxl
  text encoder swapped to fp8. No quantization workarounds, no GGUF loader, no high/low-noise expert
  split. This is what the 5B was designed for: consumer cards.
- **I2V 14B** — higher quality, but even the fp8_scaled experts are ~14 GB *each* (a high-noise and a
  low-noise model) and the practical path on 12 GB is a **GGUF** quantized build with block-swap /
  offload. More moving parts, slower, and a quality/complexity trade we do not need to take on to
  stand up the pipeline.

We take **5B now** because it fits cleanly and lets us verify the end-to-end flow on solid ground.
**14B-GGUF is noted as a future quality upgrade** — a later cycle can add it as a second quality tier
once the 5B path and the `/animate` endpoint are proven.

### Correction to the cycle brief: the 5B is fp16, not fp8
The cycle brief named an "fp8 5B diffusion model." Verified against the official
`Comfy-Org/Wan_2.2_ComfyUI_Repackaged` repo, **no fp8 5B exists** — the fp8_scaled variants are all
14B (i2v/t2v/s2v/fun). The 5B is distributed **only** as `wan2.2_ti2v_5B_fp16.safetensors`
(~9.999 GB). This does not weaken the rationale — it strengthens it: the brief wanted "fits 12 GB with
no quantization workarounds," and the stock fp16 5B *is* that file. The fp8 tricks are precisely what
the 14B needs and the 5B avoids. We pin the fp16 5B and record the discrepancy here rather than invent
a file that does not exist.

The text encoder, by contrast, **is** fetched at fp8 (`umt5_xxl_fp8_e4m3fn_scaled.safetensors`,
~6.7 GB) — that is the standard, officially-repackaged encoder for this pipeline and shaves VRAM/disk
versus the fp16 encoder with no meaningful quality loss for conditioning.

## Decision

### The three model files (pinned)
Fetched from `Comfy-Org/Wan_2.2_ComfyUI_Repackaged` (official Comfy-Org repackage of the Wan-AI
weights) into a configurable ComfyUI models root (default `~/comfyui/models`), each into ComfyUI's
conventional subdir:

| File | Subdir | Size (bytes) |
| --- | --- | --- |
| `wan2.2_ti2v_5B_fp16.safetensors` | `diffusion_models/` | 9,999,658,848 |
| `wan2.2_vae.safetensors` | `vae/` | 1,409,400,960 |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `text_encoders/` | 6,735,906,897 |

Base URL: `https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/<subdir>/<file>`.

`scripts/fetch-wan22-models.ts` downloads them **idempotently**: a file already present at its expected
size is skipped, and the script prints where every file landed. The skip decision
(`planDownloads`) is a pure function unit-tested with a mocked stat — no network in the test.

### The workflow template
`src/workflows/wan22-ti2v-5b-i2v.json` sits alongside the SDXL templates and is parameterized the same
way SDXL is — **by node id**, mutated on a fresh clone per call. Based on the official ComfyUI Wan 2.2
5B template:

- `UNETLoader "37"` (`wan2.2_ti2v_5B_fp16.safetensors`) → `ModelSamplingSD3 "48"` (`shift: 8.0`) →
  `KSampler "3"` (`euler` / `simple`, `cfg 5.0`, `steps 30`, `denoise 1.0`).
- `CLIPLoader "38"` (`umt5_xxl_fp8_e4m3fn_scaled.safetensors`, `type: wan`) → positive `"6"` /
  negative `"7"` `CLIPTextEncode`.
- `VAELoader "39"` (`wan2.2_vae.safetensors`) feeds both the latent builder and the decode.
- `LoadImage "52"` → **`ImageScale "53"`** (lanczos, `crop: disabled`, to exact target `width×height`)
  → `Wan22ImageToVideoLatent "55"` (`vae`, `width`, `height`, `length`, `start_image`).
- `KSampler "3"` → `VAEDecode "8"` → `CreateVideo "57"` (`fps`) → `SaveVideo "58"` (`mp4`/`h264`).

**The workflow scales arbitrary input sizes to the target video resolution itself** via the explicit
`ImageScale "53"` node — a caller can hand it any image dimensions; the template resizes to
`width×height` before building the latent (the Wan latent node would resize internally too, but the
explicit node makes the contract provable and testable). `src/wan-workflow.ts` exposes
`renderWanWorkflow(params)` (a pure clone-and-inject) so both the smoke script and a future
`/animate` endpoint render the same graph.

Defaults: **1280×704** (the 5B's native training resolution), **24 fps**, and a frame count **capped
at 121** (5 seconds). Frame count is snapped to Wan's valid `4k+1` grid; width/height snap to the
node's multiple-of-32 grid.

### The smoke script
`scripts/smoke-wan22.ts` takes `--image`, `--prompt`, and optional `--frames` / `--size`, renders the
template, uploads the image, submits **directly to ComfyUI's HTTP API (bypassing the service)**, polls
`/history` by its own `prompt_id`, writes the video, and prints elapsed time and output path. If
ComfyUI is unreachable **or any of the three model files is not advertised by ComfyUI's
`/object_info`, it fails loudly** with a message pointing at the fetch script. It never fabricates
success.

## Consequences
- **SDXL and Wan swap in and out of the 12 GB card.** Both pipelines target the same GPU, and neither
  fits alongside the other. Whenever the job type flips (a `/generate` after an `/animate`, or vice
  versa) ComfyUI unloads one model set and loads the other — a **one-time model-load pause** (tens of
  seconds off cold disk) on the first job after a flip. Back-to-back jobs of the same type do not pay
  it. The future `/animate` endpoint will need a video-tier timeout that absorbs this, separate from
  the image tiers.
- **Video generation is minutes, not seconds.** A 121-frame 5B render is far slower than a still; the
  smoke script measures it, and the future endpoint's timeout budget must reflect it.
- **ComfyUI must be current.** Wan 2.2 nodes (`Wan22ImageToVideoLatent`, `CreateVideo`, `SaveVideo`,
  `ModelSamplingSD3`) require a recent ComfyUI build — update ComfyUI before fetching models.
- **~18 GB of model downloads** land on the ComfyUI box before the first render; the fetch script is
  idempotent so re-runs are cheap.
- **14B-GGUF remains open** as a future higher-quality tier; this cycle deliberately does not attempt
  it.
- No change to image generation: no existing endpoint, SDXL template, or engine path is touched.
