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

## How it fits on the LAN

This service runs **on the GPU box** (next to ComfyUI). Other apps on the LAN don't talk to
ComfyUI directly — they POST a finished prompt to this service and get PNG bytes back:

```
other LAN app  ──HTTP──▶  imagegen-service (GPU box :8189)  ──HTTP──▶  ComfyUI (:8188)  ──▶ GPU
```

So from another machine you call `http://<gpu-box-ip>:8189/generate`. The service binds
`0.0.0.0` by design (see [Config](#config)); an optional shared token can gate it (see
[Authentication](#authentication)).

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
  "comfyui": { "url": "http://localhost:8188" },
  "server":  { "host": "0.0.0.0", "port": 8189 },
  "auth":    { "enabled": false, "token": "" }
}
```

- **`comfyui.url`** — where ComfyUI is. Usually `http://localhost:8188` (ComfyUI on the same
  box). Point it at another host to front a **remote** ComfyUI, e.g.
  `"http://192.168.1.50:8188"`.
- **`server.host`** — defaults to `0.0.0.0` (LAN-exposed) **by design**: the service exists to be
  called across the LAN, matching the open-ComfyUI stance. Set it to `127.0.0.1` if you ever want
  local-only.
- **`server.port`** — defaults to `8189` (sits next to ComfyUI's `8188`).
- **`auth`** — optional shared-token gate, **off by default**. See below.

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
{ "prompt": "a stone bridge over a misty gorge",  // required
  "negativePrompt": "extra text",                 // optional; appended to baseline negatives
  "style": "oil painting",                        // optional; see GET /styles
  "quality": "fast | standard | high",            // optional; default "standard"
  "seed": 12345 }                                 // optional; random if omitted
```

- `200 image/png` — raw bytes.
- `422` — bad/missing params (JSON error body).
- `503` — ComfyUI unreachable / timed out / rejected the workflow (JSON error body).
- `401` — only when auth is enabled and the bearer token is missing/wrong.

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

### `GET /styles`

Lists the preset styles that have a LoRA recipe. Styles not listed are still accepted by
`/generate` and rendered prompt-only. Gated by the token when auth is enabled.

```bash
curl http://localhost:8189/styles
# auth on:
curl -H 'Authorization: Bearer choose-a-long-random-string' http://localhost:8189/styles
```

### `GET /health`

Always open (never gated), so monitoring works without the token.

```bash
curl http://localhost:8189/health
```

```json
{ "comfyuiReachable": true, "comfyuiUrl": "http://localhost:8188",
  "lorasLoaded": ["ClassipeintXL2.1.safetensors", "..."] }
```

`lorasLoaded` reports which recipe LoRAs are actually present on the ComfyUI host.

## Deployment (systemd)

For an always-on host, run the service under **systemd** so it starts on boot and restarts on
crash — instead of leaving `npm start` in a terminal. This is for the machine that *hosts* the
service (the GPU box); other devices just POST to it over the LAN.

A ready-to-install unit lives at [`deploy/imagegen-service.service`](deploy/imagegen-service.service).
It runs `npm start` (build-free `tsx src/index.ts`) as the same user, next to `comfyui.service`,
and reads all runtime config from `config.json` — no secrets or paths are baked into the unit.

### Install

1. Review the unit and adjust `User` / `WorkingDirectory` if your checkout differs, and confirm
   `ExecStart`:

   ```bash
   nano deploy/imagegen-service.service
   ```

   `ExecStart` must be an **absolute** npm path — systemd ignores your login `PATH`, and
   **nvm-installed node is invisible to it**. Find yours with `which npm`. If it lives under
   `~/.nvm` (e.g. `/home/kb/.nvm/versions/node/v22.22.3/bin/npm`), either hard-code that path in
   `ExecStart` or install a system Node so `/usr/bin/npm` exists:

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs
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
