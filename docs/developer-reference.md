# Developer reference

The technical side of **imagegen-service** — the HTTP contract, configuration, authentication, and
always-on deployment. New here or not a developer? Start with the
[plain-language guide](README.md) instead.

imagegen-service is a small standalone HTTP service that fronts a local
[ComfyUI](https://github.com/comfyanonymous/ComfyUI) instance so multiple LAN apps can share one
dev-PC GPU without each reimplementing the `POST /prompt → poll /history → fetch /view` dance.

It is a clean-room extraction of Chronicle's local image backend (see
[adr/0001-imagegen-service-spec.md](adr/0001-imagegen-service-spec.md)) — it does **not** import
from or depend on Chronicle. It keeps the reusable engine (quality tier → workflow selection,
style → LoRA recipe injection, the ComfyUI transport, never-throw + tier-aware timeouts) and drops
Chronicle's prompt construction and disk saving: callers send a finished prompt and get raw PNG
bytes back to persist themselves.

## Contents

- [How it fits on the LAN](#how-it-fits-on-the-lan)
- [Requirements](#requirements)
- [Run](#run)
- [Config](#config)
- [Authentication](#authentication)
- [Endpoints](#endpoints)
- [Quality tiers](#quality-tiers)
- [Built-in test UI](#built-in-test-ui)
- [Deployment (systemd)](#deployment-systemd)
- [Test](#test)

## How it fits on the LAN

This service runs **on the GPU box** (next to ComfyUI). Other apps on the LAN don't talk to
ComfyUI directly — they POST a finished prompt to this service and get PNG bytes back:

```
other LAN app  ──HTTP──▶  imagegen-service (GPU box :8189)  ──HTTP──▶  ComfyUI (:8188)  ──▶ GPU
```

So from another machine you call `http://<gpu-box-ip>:8189/generate`. The service binds
`0.0.0.0` by design (see [Config](#config)); an optional shared token can gate it (see
[Authentication](#authentication)).

The whole stack — ComfyUI, the SDXL models + LoRAs, this service, and reboot-surviving auto-start
services — can be set up with the platform installers described in the
[user install guides](install-ubuntu.md); this reference covers running and configuring the service
by hand.

## Requirements

- Node 20+ (uses built-in `fetch` and `node --test`).
- A running ComfyUI with SDXL base + refiner checkpoints, `sdxl_vae.safetensors`, and the recipe
  LoRAs under `models/loras/` (see [`src/style-loras.ts`](../src/style-loras.ts)).
- **Optional, for reference images:** the ComfyUI IP-Adapter custom node plus
  `ip-adapter-plus-face_sdxl_vit-h.safetensors` and `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors`
  (the service degrades gracefully to prompt-only if these are absent).
- **Optional, for upscaling:** at least one upscale model in `models/upscale_models/` (e.g.
  `RealESRGAN_x4plus.pth`). Without one, `upscale` requests return 503; everything else works.

To add your own checkpoints, LoRAs, or video models by hand — and to check one will fit your
hardware first — see [Adding models](adding-models.md).

## Run

```bash
npm install
cp config.example.json config.json   # optional; defaults are used if absent
npm start                             # listens on 0.0.0.0:8189 by default
```

For an always-on, boot-persistent install, run it under systemd — see
[Deployment (systemd)](#deployment-systemd).

## Config

File-based only (**no environment variables**). `config.json` is git-ignored; the loader falls
back to `config.example.json`, then to built-in defaults. Copy the example and edit it:

```bash
cp config.example.json config.json
```

```json
{
  "comfyui": { "url": "http://localhost:8188", "checkpoint": "", "upscaleModel": "" },
  "server":  { "host": "0.0.0.0", "port": 8189 },
  "auth":    { "enabled": false, "token": "" }
}
```

- **`comfyui.url`** — where ComfyUI is. Usually `http://localhost:8188` (ComfyUI on the same
  box). Point it at another host to front a **remote** ComfyUI, e.g.
  `"http://192.168.1.50:8188"`.
- **`comfyui.checkpoint`** — the default base SDXL checkpoint, named exactly as ComfyUI lists it
  (e.g. `"sd_xl_base_1.0.safetensors"`). **Empty string** (the default) keeps the workflow
  templates' built-in checkpoint. Any checkpoint installed in ComfyUI's `models/checkpoints/` can
  be named here; a per-request `checkpoint` overrides it. See ADR-0004.
- **`comfyui.upscaleModel`** — the default upscale model, named as ComfyUI lists it (e.g.
  `"RealESRGAN_x4plus.pth"`). **Empty string** (the default) auto-picks the first installed model
  when a request asks to upscale; a per-request `upscaleModel` overrides it. See ADR-0006.
- **`server.host`** — defaults to `0.0.0.0` (LAN-exposed) **by design**: the service exists to be
  called across the LAN, matching the open-ComfyUI stance. Set it to `127.0.0.1` if you ever want
  local-only.
- **`server.port`** — defaults to `8189` (sits next to ComfyUI's `8188`).
- **`auth`** — optional shared-token gate, **off by default**. See below.

## Downloading models (Civitai API key)

The model files are fetched by the platform installers from
[`install/models.manifest`](../install/models.manifest). Some sources are on Civitai, whose download
endpoints are often login-gated. To let those succeed, supply a Civitai API key
([get one here](https://civitai.com/user/account) → API Keys) any of three ways — precedence
**flag > env > file**:

```bash
# 1. flag
bash install/install-linux.sh --civitai-token <key>
# 2. environment variable (shell installer only)
CIVITAI_TOKEN=<key> bash install/install-linux.sh
# 3. a gitignored file (copy the template, then fill it in)
cp install/secrets.env.example install/secrets.env   # then set CIVITAI_TOKEN=<key>
```

On Windows use `-CivitaiToken <key>` instead of the flag. The key is a **download-time** secret: it
is used **only** for `civitai.com` downloads (never sent to Hugging Face or any other host), it is
**never** read by the running service (the `src/` no-env invariant is preserved), and
`install/secrets.env` is git-ignored. Without a key, gated Civitai sources simply fall back to their
Hugging Face mirror, exactly as before. See ADR-0013.

## Authentication

Optional shared-token auth, **disabled by default** (ADR-0002). With `auth.enabled: false` the
service is fully open on the LAN — the intended stance for a trusted network, matching ComfyUI and
Chronicle. Turn it on only when a non-trusted device might join the network.

Enable it by editing `config.json` and restarting:

```json
"auth": { "enabled": true, "token": "choose-a-long-random-string" }
```

When enabled:

- **`/generate`** and **`/styles`** require `Authorization: Bearer <token>`. A missing or wrong
  token gets a bare `401 { "error": "unauthorized" }` (the response never reveals whether a token
  is required, missing, or merely wrong).
- **`/health` stays open** regardless — so monitoring/liveness works without the token.

The token lives only in the git-ignored `config.json` — never commit it. (If `enabled` is `true`
but `token` is empty, the service fails closed: every gated request is rejected, and startup logs
a warning.)

## Endpoints

### `POST /generate` → `image/png`

```jsonc
{ "prompt": "a stone bridge over a misty gorge",  // required, non-empty
  "negativePrompt": "extra text",                 // optional; appended to baseline negatives
  "style": "oil painting",                        // optional; see GET /styles
  "quality": "fast | standard | high",            // optional; default "standard"
  "seed": 12345,                                  // optional; random if omitted
  "width": 832,                                   // optional; multiple of 8 in [256, 2048]; default 1024
  "height": 1216,                                 // optional; multiple of 8 in [256, 2048]; default 1024
  "checkpoint": "myModel.safetensors",            // optional; base checkpoint override (see below)
  "initImage": "<base64-png>",                    // optional; img2img starting image (see below)
  "denoise": 0.65,                                // optional; img2img strength in (0, 1]; default 0.65
  "references": ["<base64-png>"],                 // optional; up to 4 base64 PNGs (see below)
  "referenceStrength": 0.55,                      // optional; number in (0, 1.5]; default 0.55
  "upscale": 2,                                   // optional; enlarge factor in (1, 4] (see below)
  "upscaleModel": "RealESRGAN_x4plus.pth" }       // optional; which upscale model (see below)
```

- `200 image/png` — raw bytes.
- `422` — bad/missing params (JSON error body).
- `503` — ComfyUI unreachable / timed out / rejected the workflow (JSON error body).
- `401` — only when auth is enabled and the bearer token is missing/wrong.

The maximum request body is **16 MB** (raised from 1 MB to accommodate base64 references).

```bash
# From the GPU box (or replace localhost with <gpu-box-ip> from another machine):
curl -X POST http://localhost:8189/generate \
  -H 'content-type: application/json' \
  -d '{"prompt":"a stone bridge over a misty gorge","style":"oil painting","quality":"standard"}' \
  -o out.png
```

With auth enabled, add the bearer header:

```bash
curl -X POST http://localhost:8189/generate \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer choose-a-long-random-string' \
  -d '{"prompt":"a stone bridge over a misty gorge","style":"oil painting"}' \
  -o out.png
```

#### Base checkpoint override

`checkpoint` selects the base SDXL model for this request. It accepts **either a friendly catalog
name** (e.g. `"dreamshaper"` — see `GET /checkpoints`) **or the exact ComfyUI filename** (see
`GET /health` for the installed list). Notes:

- Precedence is **request `checkpoint` > `config.comfyui.checkpoint` > the workflow template's
  built-in checkpoint**. Omit it to use the configured/default model. A catalog name resolves to its
  filename; anything else is passed to ComfyUI as-is.
- Only the **base** checkpoint is overridden. At `quality: "high"` the SDXL **refiner** stays stock
  (`sd_xl_refiner_1.0.safetensors`); a custom base not paired with that refiner is best used at
  `fast`/`standard`.
- Any SDXL checkpoint installed in ComfyUI's `models/checkpoints/` works. The name is validated
  lightly (non-empty, ≤ 200 chars, no path traversal); ComfyUI is the authority — an **unknown name
  returns `503`** (rejected workflow), it is not silently swapped.

#### Image-to-image (`initImage` / `denoise`)

Supplying `initImage` (a base64 PNG) starts the render **from that image** instead of from noise, and
the prompt repaints it — restyling a photo, iterating on an existing image, etc. (ADR-0005).

- **`denoise`** (`(0, 1]`, default **0.65**) is the whole knob: low (~0.3) stays very close to the
  input, high (~0.85) transforms it heavily, `1` ≈ ignores it (pure txt2img).
- **Output size follows the input image**; `width`/`height` are ignored in img2img mode.
- **Forces the base workflow** even at `quality: "high"` (the refiner graph differs).
- Composes with `style`, `checkpoint`, and `negativePrompt`. Send ~1 MP images — very large inputs
  are slow and can duplicate/warp (the built-in UI downscales to ≤1024px automatically).
- If the upload to ComfyUI fails, the request returns **503** (it does *not* silently fall back to
  txt2img — that would ignore your image).

> **img2img vs. reference images:** `initImage` uses your image's *pixels* as the canvas.
> `references` (below) instead keeps a *face/identity* while generating a brand-new scene. Different
> jobs — pick `initImage` to transform a picture, `references` to keep a character consistent.

#### Reference images (IP-Adapter / character consistency)

Supplying `references` makes the rendered subject **resemble a reference portrait** — useful for
keeping a character's face/identity consistent across different scenes, while the text prompt still
drives the scene itself. Notes on the current behavior:

- `references` is an array of **up to 4** base64-encoded PNG strings. Only the **first** is used
  today; the rest are validated but ignored.
- `referenceStrength` (the IP-Adapter weight) is a number in `(0, 1.5]`, default **0.55**. The
  default is tuned so identity is preserved without collapsing every scene into a bust portrait;
  raise it for a stronger likeness, lower it for more scene freedom.
- Reference images **force the base workflow** even at `quality: "high"` (the refiner graph has a
  different node shape), rendering base at standard steps.
- It requires the IP-Adapter custom node + models on the ComfyUI host (see
  [Requirements](#requirements)). If they're missing or an upload fails, the request **degrades
  gracefully to prompt-only** rather than erroring.

#### Upscaling (`upscale` / `upscaleModel`)

`upscale` enlarges the **finished** image with a trained super-resolution (ESRGAN-style) model — a
post-process, so it works on any generation (txt2img, img2img, styled, etc.). See ADR-0006.

- **`upscale`** is the target factor in `(1, 4]` (e.g. `2`, `4`). **Output size = generated size ×
  factor** (a 4× of 1024² is 4096²).
- **`upscaleModel`** picks which model, named as ComfyUI lists it (see `GET /health` for the
  installed list). Precedence: **request > `config.comfyui.upscaleModel` > the first installed
  model**.
- Requires an upscale model in ComfyUI's `models/upscale_models/`. If **none is installed** the
  request returns **503** (it does not silently skip) — put one there (e.g. `RealESRGAN_x4plus.pth`).
- This is pure super-resolution (sharpen + enlarge). It does not re-imagine detail.

### `POST /animate` → `video/mp4`

Turns a **still image into a short video** through the same ComfyUI instance
(ADR-[0008](adr/0008-image-to-video-wan22.md)/[0009](adr/0009-animate-endpoint.md)/[0015](adr/0015-multi-model-video-dispatch.md)).
JSON in, raw **mp4 bytes** out (200/422/503). Gated by the token when auth is enabled. Two models are
available via the `model` field: **`wan-5b`** (Wan 2.2 TI2V 5B, the default) and **`ltxv`** (LTX-Video
2B — faster and lighter).

```bash
curl -X POST http://localhost:8189/animate \
  -H 'content-type: application/json' \
  -d '{
        "image": "'"$(base64 -w0 still.png)"'",
        "prompt": "the scene comes to life, gentle camera push-in",
        "frames": 121,
        "fps": 24
      }' --output animated.mp4
```

| Field | Type | Notes |
|---|---|---|
| `image` | base64 string | **required** — the still to animate. |
| `prompt` | string | **required** — how it should move. |
| `model` | string | `wan-5b` (default) or `ltxv`. An unknown value is a **422**. |
| `negativePrompt` | string | Appended to the model's baseline negative. |
| `seed` | number | Omit for a random seed. |
| `width` / `height` | integer `[256, 2048]` | Target resolution, snapped to each model's ×32 grid. Default **1280×704** (wan-5b) / **768×512** (ltxv). |
| `frames` | integer `[1, 121]` | Snapped to the model's grid (wan-5b `4k+1`, ltxv `8n+1`). Default **121** (wan-5b) / **97** (ltxv). |
| `fps` | number `[1, 120]` | Default **24**. |

- **Requires that model's files** on the ComfyUI host — `wan-5b` needs the three Wan files
  (`scripts/fetch-wan22-models.ts`); `ltxv` needs the LTX checkpoint + T5 encoder
  (`scripts/fetch-ltxv-models.ts`). If any is missing the request returns **503** naming exactly what
  to fetch and which script to run. For `wan-5b`, `GET /health`'s `wan` block (`{ "ready": true }`)
  reports availability up front.
- **Renders take minutes**, and the **first** animation after an image job (or vice-versa) also pays a
  one-time **model-load pause** as SDXL and Wan swap on the 12 GB card. Set a generous client read
  timeout; the server's own poll budget is 20 minutes.
- No LoRA/style/upscale/refiner interplay — this is a separate, video-only path. `/generate` is
  unchanged.

### `POST /stitch` → `video/mp4`

Joins several clips into one video (ADR-[0010](adr/0010-video-stitching.md)). JSON in, combined **mp4
bytes** out. Auth-gated. Since clips from `/animate` are all H.264 at the same resolution/fps, this is
a lossless `ffmpeg` stream copy (`-c copy`) — near-instant, no re-encode.

```bash
curl -X POST http://localhost:8189/stitch \
  -H 'content-type: application/json' \
  -d '{"clips":["'"$(base64 -w0 clip1.mp4)"'","'"$(base64 -w0 clip2.mp4)"'"]}' \
  --output sequence.mp4
```

| Field | Type | Notes |
|---|---|---|
| `clips` | string[] | **required** — 2–50 base64 mp4 clips, in play order. |

- The service is stateless (it never saves what it renders), so the **client uploads the clips back**.
  This route allows a larger request body (256 MB) than the image routes; over that → **413**.
- **Requires `ffmpeg`** on the host (present alongside ComfyUI). Absent → **503**; check `GET /health`'s
  `stitch.available` first.
- Clips should share **resolution and fps** (the `/animate` defaults guarantee this). Mixed sizes make
  `ffmpeg` fail → a clear **503**, never a silently broken file.

### `GET /styles`

Lists the preset styles that have a LoRA recipe. Styles not listed are still accepted by
`/generate` and rendered prompt-only. Gated by the token when auth is enabled.

```bash
curl http://localhost:8189/styles
# auth on:
curl -H 'Authorization: Bearer choose-a-long-random-string' http://localhost:8189/styles
```

```json
{ "styles": [
    { "name": "oil painting", "hasLora": true, "trigger": "oil painting",
      "strength": 0.8, "loraFile": "ClassipeintXL2.1.safetensors" }
  ],
  "note": "Styles not listed here are accepted by /generate and rendered prompt-only (no LoRA)." }
```

The 33 preset styles are `pixel art`, `oil painting`, `comic book`, `lego-style`, `pencil sketch`,
`watercolour`, `anime`, `storybook`, `3d`, `cyberpunk`, `ukiyo-e`, `claymation`, `line art`,
`coloring book`, `papercut`, `isometric`, `stained glass`, `embroidery`, `amigurumi`, `vaporwave`,
`low-poly`, `art nouveau`, `ink wash`, `flat vector`, `travel poster`, `sticker`, `gouache`,
`charcoal`, `art deco`, `risograph`, `cel shading`, `woodcut`, and `blueprint`. Names are matched
case-insensitively. `noir` and `ghibli` are intentionally prompt-only (no reliable base-SDXL LoRA).

### `GET /checkpoints`

Lists the curated SFW base-model catalog. Each entry is `{ name, file, description, installed }`,
where `installed` reflects whether the file is actually loaded on the fronted ComfyUI. Pass a `name`
in `/generate`'s `checkpoint` field (or the exact `file`). Gated by the token when auth is enabled.

```bash
curl http://localhost:8189/checkpoints
```

```json
{ "checkpoints": [
    { "name": "realvisxl", "file": "RealVisXL_V5.0_fp16.safetensors",
      "description": "Photorealistic people and scenes (RealVis XL v5).", "installed": true }
  ],
  "note": "Any checkpoint installed in ComfyUI's models/checkpoints/ also works by exact filename via the `checkpoint` field on /generate." }
```

The 10 catalog names are `realvisxl`, `juggernaut`, `animagine`, `zavychroma` (ADR-0014, ungated HF),
plus `dreamshaper`, `realcartoon`, `nightvision`, `colorful`, `samaritan3d`, `starlight` (ADR-0016,
from Civitai) — all full SFW SDXL checkpoints. The files are downloaded by the installer (see
[`install/models.manifest`](../install/models.manifest)); a catalog entry with `installed: false`
just hasn't been downloaded on this box yet (the Civitai ones need the API key — see
[Downloading models](#downloading-models-civitai-api-key)).

### `GET /health`

Always open (never gated), so monitoring works without the token.

```bash
curl http://localhost:8189/health
```

```json
{ "comfyuiReachable": true, "comfyuiUrl": "http://localhost:8188",
  "lorasLoaded": ["ClassipeintXL2.1.safetensors", "..."],
  "checkpoint": "sd_xl_base_1.0.safetensors",
  "checkpoints": ["sd_xl_base_1.0.safetensors", "sd_xl_refiner_1.0.safetensors", "..."],
  "upscaleModel": "RealESRGAN_x4plus.pth",
  "upscaleModels": ["RealESRGAN_x4plus.pth", "..."],
  "wan": { "ready": true, "missing": [] },
  "stitch": { "available": true } }
```

- `lorasLoaded` — which recipe LoRAs are actually present on the ComfyUI host.
- `checkpoint` — the **effective default** base checkpoint (config override, else the workflow
  template's).
- `checkpoints` — every checkpoint ComfyUI can load, so a client can offer a model picker (the
  built-in test UI does exactly this).
- `upscaleModel` / `upscaleModels` — the effective default upscale model (config override, else the
  first installed) and the full installed list (empty if none — upscaling is then unavailable).
- `wan` — image-to-video readiness: `{ "ready": <all three Wan files present>, "missing": [...] }`.
  `POST /animate` works only when `ready` is `true`; `missing` names what `scripts/fetch-wan22-models.ts`
  should fetch.
- `stitch` — `{ "available": <ffmpeg present on the host> }`. `POST /stitch` works only when `true`.

## Quality tiers

`quality` selects a workflow and a sampler-step budget, trading speed for refinement:

| `quality` | Workflow | Base steps | Poll timeout |
|---|---|---|---|
| `fast` | base (`sdxl-txt2img.json`) | 15 | 120 s |
| `standard` *(default)* | base (`sdxl-txt2img.json`) | 25 | 120 s |
| `high` | base + refiner (`sdxl-refiner.json`) | workflow default | 300 s |

Two interactions to be aware of:

- **A LoRA style skips the refiner.** If a LoRA-backed `style` is requested at `quality: "high"`,
  it renders the base workflow at 40 steps instead (LoRA injection is wired only on the base chain),
  keeping high's larger time budget.
- **Reference images force the base workflow** at standard steps, even at `quality: "high"` (see
  [Reference images](#reference-images-ip-adapter--character-consistency)).

## Built-in test UI

For quick manual checks, the server also serves a tiny **dev/test** page at `GET /` (and
`GET /index.html`) — a single self-contained HTML file ([`src/ui.html`](../src/ui.html), inline CSS +
vanilla JS, no build step, no new deps). Open it in a browser:

```
http://localhost:8189/        # or http://<gpu-box-ip>:8189/ from another machine
```

It shows a health line (ComfyUI reachable? how many recipe LoRAs), a style dropdown populated from
`/styles`, a **Model dropdown** populated from `/health`'s installed-checkpoint list (defaulting to
the effective checkpoint), width/height fields, and two optional image pickers — a **Starting image**
(img2img, with a "change amount"/denoise slider) and a **Reference photo** (IP-Adapter, with a
likeness slider), and an **Upscale** control (Off / 2× / 4×, enabled when an upscale model is
installed). The form POSTs to `/generate` and renders the returned PNG with the elapsed time;
errors (401/422/503) are shown readably. Chosen images are downscaled client-side to ≤1024px before
upload. It's a convenience harness only — not a production surface.

When `auth.enabled` is `true`, paste the token into the page's **Auth token** field: `/styles` and
`/generate` are gated (the dropdown shows an "enter token" hint until you do), while the page itself
and `/health` always load without one.

## Deployment (systemd)

For an always-on host, run the service under **systemd** so it starts on boot and restarts on
crash — instead of leaving `npm start` in a terminal. This is for the machine that *hosts* the
service (the GPU box); other devices just POST to it over the LAN.

A ready-to-install unit lives at [`deploy/imagegen-service.service`](../deploy/imagegen-service.service).
It runs the same thing `npm start` runs (build-free `tsx src/index.ts`) as the same user, next to
`comfyui.service`, and reads all runtime config from `config.json` — no secrets or paths are baked
into the unit.

> **⚠️ The `ExecStart` node path is nvm-version-specific.** systemd runs with a bare `PATH` and
> does **not** see your login shell or nvm, so `npm` and a bare `node` are invisible to it — an
> `ExecStart=/usr/bin/npm` fails with `status=203/EXEC`. The unit therefore invokes **node by
> absolute path** (`--import tsx src/index.ts`, exactly how the test runner loads tsx) and sets
> `Environment=PATH` so node's siblings resolve. That path embeds the nvm node version
> (`v22.22.3`): **if you upgrade node, update both the `ExecStart` and the `Environment=PATH` line**
> (or point them at a stable symlink you control, e.g. `/usr/local/bin/node`, to avoid re-editing
> on every upgrade). The sibling `chronicle.service` on the i5 server needs this same fix.

### Install

1. Review the unit and adjust it for your box — `User` / `WorkingDirectory` if your checkout
   differs, and **the node path** in `ExecStart` + `Environment=PATH` to match `which node`:

   ```bash
   which node                        # e.g. /home/kb/.nvm/versions/node/v22.22.3/bin/node
   nano deploy/imagegen-service.service
   ```

2. Install and enable it (start on boot + start now):

   ```bash
   sudo cp deploy/imagegen-service.service /etc/systemd/system/imagegen-service.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now imagegen-service
   ```

3. Confirm it's up:

   ```bash
   systemctl status imagegen-service   # expect: active (running)
   ```

   You should see the log line
   `[imagegen-service] listening on http://0.0.0.0:8189 -> ComfyUI http://localhost:8188 [open (no auth)]`.

### Everyday commands

```bash
systemctl status imagegen-service         # is it running?
journalctl -u imagegen-service -f         # live logs
sudo systemctl restart imagegen-service   # after a git pull or a config.json change
sudo systemctl stop imagegen-service      # take it down
```

There is no hot-reload — the server runs your checked-out `src/` and `config.json` as-is, so
**after changing code or config, restart the service**.

### Validate the unit before installing

```bash
systemd-analyze verify deploy/imagegen-service.service
```

## Test

```bash
npm run test:unit   # node --test via tsx; CI-safe, mocks ComfyUI (no GPU needed)
```
