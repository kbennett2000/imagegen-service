# Adding models — checkpoints, LoRAs, and video

This is the maintainer guide for **manually downloading and installing new models** into a running
imagegen-service + ComfyUI box, and for **checking a model will run on your hardware** before you
spend time (and ~6–18 GB of bandwidth) downloading it.

Related reading: [`developer-reference.md`](developer-reference.md) (config keys, `/health`),
ADR-[0004](adr/0004-selectable-base-checkpoint.md) (checkpoint selection),
ADR-[0008](adr/0008-image-to-video-wan22.md) (the Wan video models), and
[`install/models.manifest`](../install/models.manifest) (the URL list the auto-installer uses).

## The one thing to understand first

The service itself never knows filesystem paths. It refers to every model **by filename only** and
asks ComfyUI what it can actually load (via ComfyUI's `/object_info`). So *installing* a model is
always the same three moves, whatever the type:

1. **Drop** the file into the correct `~/comfyui/models/<subdir>/` folder.
2. **Restart ComfyUI** so it re-scans and starts advertising the file.
3. **Point the service at it** — a request param / `config.json` (checkpoints, upscale), or a code
   edit (`src/style-loras.ts` for LoRAs, a workflow JSON for video).

`GET /health` is your ground truth at every step — it lists the checkpoints, LoRAs, and upscale
models ComfyUI is actually advertising, plus a `wan` readiness block for video.

---

## 0. Before you download — will it run on this box?

Run this checklist *before* downloading. The reference box is an **RTX 5070 with 12 GB VRAM**; the
numbers below assume that ceiling.

**Right architecture.** The image workflows here are **SDXL**. A checkpoint or LoRA must be
**SDXL-based** — an SD 1.5, SD 3, Flux, Pony, or Illustrious file will *load* but produce broken or
ignored output, because the workflow nodes, the VAE (`sdxl_vae.safetensors`), and the latent shapes
all assume SDXL. On CivitAI / Hugging Face, look for a **"SDXL 1.0"** base model. Video models must
be **Wan 2.2**-class to match the loader nodes (`UNETLoader` / `CLIPLoader type: wan` / `VAELoader`).

**Right format.** Prefer **`.safetensors`**. (The one exception is upscale models, which are ESRGAN
`.pth` files.)

**VRAM fits — 12 GB ceiling.** Rules of thumb for a 12 GB card:

| Model | Fits 12 GB? | Note |
|---|---|---|
| SDXL checkpoint (~6.5 GB) | ✅ comfortably | base or a fine-tune |
| SDXL + one LoRA + refiner | ✅ | refiner swaps in after the base pass |
| Wan 2.2 **TI2V 5B fp16** (~10 GB) | ✅ *just* | only because the text encoder is the fp8 `umt5_xxl_fp8_e4m3fn_scaled` — this is the practical video ceiling for 12 GB |
| Wan **14B** | ❌ | needs ~14 GB *per* expert (high+low noise); would require a GGUF / block-swap path that isn't implemented. Out of scope on this box. |

SDXL and Wan **swap in and out** of the 12 GB card — you never need both resident at once, but the
first job after a type flip (image→video or back) pauses to load the model.

**Disk space.** An SDXL checkpoint is ~6.5 GB; the full Wan set is ~18 GB. Check with `df -h ~`.

**How to read your card.** `nvidia-smi` — the total in the "Memory-Usage" column is your VRAM
ceiling. The platform installer's preflight also prints this.

---

## 1. Where models live (the map)

Everything lives under the ComfyUI models root, **`~/comfyui/models/`** by default. The service
knows *filenames*; ComfyUI owns the directory layout.

| Subdir | Holds | The service references it via |
|---|---|---|
| `checkpoints/` | SDXL base & refiner (or your fine-tune) | workflow `ckpt_name`, `config.comfyui.checkpoint`, request `checkpoint` |
| `vae/` | `sdxl_vae.safetensors`, `wan2.2_vae.safetensors` | workflow `vae_name` |
| `loras/` | the 12 style LoRAs | recipes in [`src/style-loras.ts`](../src/style-loras.ts) |
| `upscale_models/` | ESRGAN `.pth` (e.g. `RealESRGAN_x4plus.pth`) | auto-picked, or `config.comfyui.upscaleModel` |
| `diffusion_models/` | `wan2.2_ti2v_5B_fp16.safetensors` | video workflow `unet_name` |
| `text_encoders/` | `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | video workflow `clip_name` |
| `ipadapter/`, `clip_vision/` | IP-Adapter + CLIP-Vision (optional) | constants in [`src/engine.ts`](../src/engine.ts) |

---

## 2. Adding a base checkpoint

The easiest and most flexible case — **no code or workflow edits needed** (ADR-0004).

1. Confirm it's **SDXL 1.0** architecture and `.safetensors` (see §0).
2. Download into `~/comfyui/models/checkpoints/`:
   ```bash
   curl -L -f -o ~/comfyui/models/checkpoints/myModelSDXL.safetensors "<direct-url>"
   ```
   If a CivitAI link returns a login page instead of a model, use an ungated Hugging Face mirror —
   the same primary/fallback pattern `install/models.manifest` uses. Sanity-check the result:
   `ls -lh` should show **gigabytes**, not a few KB (a few KB means you saved an HTML error page).
3. **Restart ComfyUI** so it re-scans (`systemctl --user restart comfyui`, or however you run it).
4. Confirm the service can see it:
   ```bash
   curl -s localhost:8189/health | grep -o 'myModelSDXL[^"]*'
   ```
   (`/health` lists the installed checkpoints ComfyUI advertises.)
5. **Select it.** Precedence is **request > `config.json` > template default** (ADR-0004):
   - Per request — `POST /generate` with `"checkpoint": "myModelSDXL.safetensors"`.
   - As the new default — set `comfyui.checkpoint` in `config.json`, then restart the service.
   - Leave it `""` to keep the template default, `sd_xl_base_1.0.safetensors`.

Two caveats worth knowing:

- The style LoRAs were tuned against SDXL **base**; a custom checkpoint can shift how their triggers
  land. Test the styles you care about.
- The **high** tier's refiner still uses `sd_xl_refiner_1.0.safetensors` unless you swap that too.

---

## 3. Adding a style LoRA

1. SDXL-based LoRA, `.safetensors`, into `~/comfyui/models/loras/`.
2. Add a recipe entry to [`src/style-loras.ts`](../src/style-loras.ts) (`STYLE_LORAS`) — copy an
   existing block and adjust:
   ```ts
   "my style": { loraFile: "my-lora.safetensors", trigger: "my trigger",
                 strength: 0.9, noRefiner: true },
   ```
   - `trigger` is injected into the prompt so the LoRA activates.
   - `strength` is typically ~0.7–1.0.
   - Keep `noRefiner: true` like every current entry — the LoRA is wired only onto the base chain,
     which renders at 40 steps in place of the refiner.
3. Restart ComfyUI **and** the service. If the LoRA file isn't actually present at runtime the
   engine silently falls back to prompt-only, so confirm it via `/health`'s LoRA list.
4. Optional — to have the auto-installer fetch it on fresh installs, add a line to
   [`install/models.manifest`](../install/models.manifest):
   ```
   loras|my-lora.safetensors|<primary-url>|<fallback-url-or-->|<min-megabytes>
   ```

---

## 4. Adding an upscale model

Drop an ESRGAN-style `.pth` (e.g. `RealESRGAN_x4plus.pth`) into
`~/comfyui/models/upscale_models/` and restart ComfyUI. It's auto-picked (first installed) unless
you pin one with `config.comfyui.upscaleModel`, or name one per request with `upscaleModel`.

---

## 5. Adding / updating video (Wan) models

### A. Install the standard Wan 2.2 5B set — the supported path

No code changes. There's a script that fetches the three pinned files (~18 GB) idempotently:

```bash
cd ~/comfyui && git pull        # Wan 2.2 nodes need a current ComfyUI build — update it FIRST
cd ~/Desktop/projects/imagegen-service
npx tsx scripts/fetch-wan22-models.ts        # resumable; --models-root <dir> to override, --dry-run to preview
# then restart ComfyUI, and check readiness:
curl -s localhost:8189/health   # wan.ready should be true, wan.missing empty
```

The three files (from the official Comfy-Org repackage) land in the right subdirs:

| File | Subdir | Size |
|---|---|---|
| `wan2.2_ti2v_5B_fp16.safetensors` | `diffusion_models/` | ~10 GB |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `text_encoders/` | ~6.7 GB |
| `wan2.2_vae.safetensors` | `vae/` | ~1.4 GB |

Until all three are present, `POST /animate` returns **503** naming the missing files. For direct
pipeline debugging (bypassing the service) use `scripts/smoke-wan22.ts`.

### B. A *different* Wan-class video model — advanced

You must edit **three places that all have to agree on the filename**:

1. the loader-node filenames in [`src/workflows/wan22-ti2v-5b-i2v.json`](../src/workflows/wan22-ti2v-5b-i2v.json)
   (and `wan22-ti2v-5b-flf.json` for the first-last-frame variant),
2. the constants `WAN_DIFFUSION_MODEL` / `WAN_TEXT_ENCODER` / `WAN_VAE` in
   [`src/wan-workflow.ts`](../src/wan-workflow.ts),
3. the pinned spec + **exact byte size** in
   [`scripts/fetch-wan22-models.ts`](../scripts/fetch-wan22-models.ts) (the size drives the
   skip/verify decision).

Mind the 12 GB ceiling (§0): stay in the TI2V-5B-class fp16 range — 14B is not viable on this box.

---

## 6. Verifying it worked (any model type)

- **`curl -s localhost:8189/health`** — the ground truth: installed checkpoints, LoRAs, upscale
  models, and the `wan: { ready, missing }` block.
- **Image smoke** — `POST /generate` naming the new checkpoint or style.
- **Video smoke** — `scripts/smoke-wan22.ts` (fails loudly if a Wan model is missing).

If a newly added file doesn't show up: you almost certainly **didn't restart ComfyUI**, or the
filename in your config / recipe doesn't match the file on disk **byte-for-byte** (a trailing space,
a version suffix, `.safetensors` vs `.ckpt`).

---

## 7. Troubleshooting — `HTTP 503 — ComfyUI execution error`

This means the request was accepted and ComfyUI **started rendering, then failed partway** — as
opposed to a validation error (bad request) or a 503 for a *missing* model. The error line now names
the failing node and the exception, e.g.:

```
ComfyUI execution error at node 3 (KSampler): RuntimeError: mat1 and mat2 shapes cannot be multiplied
```

Read it like this:

- **The node tells you where.** `CheckpointLoaderSimple` (node 4) → the checkpoint file itself won't
  load. `KSampler` (node 3) → the model loaded but its tensors don't match the SDXL pipeline. A
  `VAE*` node → a VAE problem. (Nodes `EmptyLatentImage` and `VAELoader` succeeding tells you the
  latent/VAE setup is fine.)
- **The exception tells you why.** The two overwhelmingly common causes after adding a checkpoint:

**Cause A — the checkpoint isn't SDXL 1.0.** A shape/size mismatch (`mat1 and mat2 shapes cannot be
multiplied`, or a channel/dim error) means you installed a *different architecture* — SD 1.5, SD 3,
Flux, Pony, Illustrious, etc. These load but can't run through this service's SDXL workflow. Fix:
replace it with a model whose base is **"SDXL 1.0"**.

**Cause B — the download is corrupt or incomplete.** A `safetensors` header / "not a valid
safetensors file" / EOF error means the file isn't really a model — most often a CivitAI **login
page** or an error page saved under the `.safetensors` name, or a transfer that was cut off. Check:

```bash
ls -lh ~/comfyui/models/checkpoints/<yourfile>.safetensors   # a real SDXL checkpoint is ~6.5 GB
```

A few KB or MB confirms it. Re-download from an ungated source (an official Hugging Face repo is the
safest), then **restart ComfyUI**.

**Quickest way to isolate it:** generate again with the **stock** checkpoint — `POST /generate`
*without* a `checkpoint` field (and if you set `comfyui.checkpoint` in `config.json`, blank it to
`""` and restart the service). If the stock model works, the model you added is the problem, not your
install.

For the raw traceback, the **ComfyUI console/log** always has the full Python stack — but the
service's own error line is usually enough to tell A from B.

---

## 8. Splitting model storage across drives (a second disk)

When the main drive fills up, you can keep models on a second drive **as well as** the default
location — both show up in the Model dropdown, seamlessly. This works because the service never scans
disk: the list is whatever **ComfyUI** reports (`/object_info` → `/health`). So you only configure
ComfyUI; the service needs no change. (ADR-0017.)

**1. Make a models tree on the second drive** (mirror the layout from §1):

```bash
mkdir -p "/run/media/kb/2TB 02/comfyui-models/"{checkpoints,loras,vae,diffusion_models,text_encoders,upscale_models,clip_vision}
```

**2. Tell ComfyUI to also scan it.** Copy the template
[`install/extra_model_paths.example.yaml`](../install/extra_model_paths.example.yaml) to your ComfyUI
install root as `extra_model_paths.yaml`, set `base_path` to the dir above, and **restart ComfyUI**:

```yaml
second_drive:
    base_path: /run/media/kb/2TB 02/comfyui-models/
    checkpoints: checkpoints/
    loras: loras/
    vae: vae/
    diffusion_models: diffusion_models/
    text_encoders: text_encoders/
    upscale_models: upscale_models/
    clip_vision: clip_vision/
```

A checkpoint at `.../comfyui-models/checkpoints/foo.safetensors` now appears as `foo.safetensors`
(nested: `.../checkpoints/sdxl/foo.safetensors` → `sdxl/foo.safetensors`). Verify per §6.

**3. Downloads still land on the main drive.** Move files over manually as space runs low. So the
fetch scripts don't re-download what you've moved, point them at the second drive too — they'll treat
a full-size copy found there as already installed:

```bash
# checkpoints — flag is repeatable; env is colon-separated
scripts/fetch-missing-checkpoints.sh --extra-root "/run/media/kb/2TB 02/comfyui-models"
export COMFYUI_EXTRA_MODEL_ROOTS="/run/media/kb/2TB 02/comfyui-models"   # same effect, set once

# video models (WAN / LTXV) — flag only
npx tsx scripts/fetch-wan22-models.ts --extra-root "/run/media/kb/2TB 02/comfyui-models"
```

**Removable-drive caveat.** `/run/media/<user>/<label>` only exists while the drive is mounted — if
it's unmounted, those models drop out of the dropdown and the scripts stop seeing them (and may
re-download). For a permanent setup, give the drive a stable mountpoint in `/etc/fstab` and use that
path everywhere instead. Also prefer a real Linux filesystem (ext4/xfs/btrfs) over exFAT/NTFS for the
model drive.
