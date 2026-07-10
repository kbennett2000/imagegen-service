# imagegen-service

A small standalone HTTP service that fronts a local [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
instance so multiple LAN apps can share one dev-PC GPU without each reimplementing the
POST /prompt → poll /history → fetch /view dance.

It is a clean-room extraction of Chronicle's local image backend (see
[docs/adr/0001-imagegen-service-spec.md](docs/adr/0001-imagegen-service-spec.md)) — it does
**not** import from or depend on Chronicle. It keeps the reusable engine (quality tier → workflow
selection, style → LoRA recipe injection, the ComfyUI transport, never-throw + tier-aware
timeouts) and drops Chronicle's prompt construction and disk saving: callers send a finished
prompt and get raw PNG bytes back to persist themselves.

> Slice 1 (this build). Deployment (systemd, optional token auth, expanded docs) is slice 2.

## Requirements

- Node 20+ (uses built-in `fetch` and `node --test`).
- A running ComfyUI with SDXL base + refiner checkpoints, `sdxl_vae.safetensors`, and the recipe
  LoRAs under `models/loras/` (see `src/style-loras.ts`).

## Run

```bash
npm install
cp config.example.json config.json   # optional; defaults are used if absent
npm start                             # listens on 0.0.0.0:8189 by default
```

Config is file-based only (no environment variables). `config.json` is git-ignored; it falls
back to `config.example.json`, then to built-in defaults:

```json
{ "comfyui": { "url": "http://localhost:8188" },
  "server":  { "host": "0.0.0.0", "port": 8189 } }
```

> `server.host` defaults to `0.0.0.0` (LAN-exposed) by design — the service exists to be called
> across the LAN, matching the open-ComfyUI stance. An optional auth toggle is deferred to slice 2.

## Endpoints

### `POST /generate` → `image/png`

```jsonc
{ "prompt": "a stone bridge over a misty gorge",  // required
  "negativePrompt": "extra text",                 // optional; appended to baseline negatives
  "style": "oil painting",                        // optional; see GET /styles
  "quality": "fast | standard | high",            // optional; default "standard"
  "seed": 12345 }                                 // optional; random if omitted
```

- `200 image/png` — raw bytes.
- `422` — bad/missing params (JSON error body).
- `503` — ComfyUI unreachable / timed out / rejected the workflow (JSON error body).

```bash
curl -X POST http://localhost:8189/generate \
  -H 'content-type: application/json' \
  -d '{"prompt":"a stone bridge over a misty gorge","style":"oil painting","quality":"standard"}' \
  -o out.png
```

### `GET /styles`

Lists the preset styles that have a LoRA recipe. Styles not listed are still accepted by
`/generate` and rendered prompt-only.

### `GET /health`

```json
{ "comfyuiReachable": true, "comfyuiUrl": "http://localhost:8188",
  "lorasLoaded": ["ClassipeintXL2.1.safetensors", "..."] }
```

`lorasLoaded` reports which recipe LoRAs are actually present on the ComfyUI host.

## Test

```bash
npm run test:unit   # node --test via tsx; CI-safe, mocks ComfyUI (no GPU needed)
```
