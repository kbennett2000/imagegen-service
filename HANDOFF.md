# Handoff

## Current state
**Image upscaling (PR open for review).** Optional `upscale` factor on `POST /generate` enlarges the
finished image with an ESRGAN-style model as a post-process (ADR-0006).

- **Params**: `upscale` (factor in `(1,4]`) + optional `upscaleModel`. Precedence: request >
  `config.comfyui.upscaleModel` > first installed model.
- **Engine** `applyUpscale` inserts `UpscaleModelLoader "40"` → `ImageUpscaleWithModel "41"` (image
  `["8",0]`), plus `ImageScaleBy "42"` (`scale_by: factor/native`) when the requested factor differs
  from the model's native factor (parsed from its filename, default 4); repoints `SaveImage "9"`.
  Runs **last**, so it composes with img2img/LoRA/IP-Adapter/refiner. No model installed → clean
  **503**. Tier timeout bumped +60s when upscaling. New `listUpscaleModels` probe; `probeComfy`
  returns `upscaleModels`.
- **Config**: `comfyui.upscaleModel` (default `""` = auto-pick first). **Server**: validate `upscale`
  (`(1,4]`) + `upscaleModel` (path-safe) → 422; `/health` reports `upscaleModel` + `upscaleModels`.
- **UI** ([src/ui.html](src/ui.html)): an Upscale dropdown (Off/2×/4×), enabled only when `/health`
  lists an upscale model; a model picker appears when >1 is installed.
- Tests: `npm run test:unit` → **70 pass** (11 new). Mock gained an `upscaleModels` option +
  `/object_info/UpscaleModelLoader` route. Docs: developer-reference + ADR-0006.
- **Note:** for live use, an upscale model must sit in `~/comfyui/models/upscale_models/`
  (RealESRGAN_x4plus.pth was fetched to this box); ComfyUI may need a restart to list a newly-added
  upscale model. Branched off `master`; content-neutral.

### Prior — image-to-image + UI image inputs (merged, PR #18)
**Image-to-image + image controls in the UI (PR open for review).** Adds img2img and surfaces the
existing reference-image feature in the built-in test page (ADR-0005).

- **img2img**: optional `initImage` (base64 PNG) + `denoise` (`(0,1]`, default 0.65) on
  `POST /generate`. Engine `applyImg2Img` injects `LoadImage("30") → VAEEncode("31")` (reusing
  `VAELoader "10"`) and repoints base sampler `"3"` `latent_image`/`denoise`. Forces the base
  workflow at `quality:"high"` (like `references`); composes with style/checkpoint/negatives. Output
  size follows the input image (`width`/`height` ignored). Upload failure → clean **503** (does NOT
  silently fall back to txt2img). The base64 uploader `uploadReference` was renamed **`uploadImage`**.
- **Server**: `parseGenerateBody` validates `initImage` (non-empty) + `denoise` (`(0,1]`) → 422.
- **UI** ([src/ui.html](src/ui.html)): a "Starting image" (img2img) picker + "Change amount"
  (denoise) slider, and a "Reference photo" picker + "Likeness strength" slider (surfacing the
  pre-existing `references`/`referenceStrength` params). Images are downscaled client-side to ≤1024px
  before upload.
- Tests: `npm run test:unit` → **59 pass** (9 new). Mock gained an `uploadStatus` option for the
  upload-failure path. Docs: [docs/developer-reference.md](docs/developer-reference.md) + ADR-0005.
- Branched off `master`; content-neutral.

### Prior — selectable base checkpoint + UI (merged, PRs #16/#17)
**Selectable base checkpoint (PR open for review).** The SDXL base checkpoint is no longer hardcoded
to `sd_xl_base_1.0.safetensors`; it's now selectable (ADR-0004), fully backward-compatible.

- **Config** `comfyui.checkpoint` (default `""` = keep the workflow templates' checkpoint) in
  [src/config.ts](src/config.ts) + [config.example.json](config.example.json).
- **Per-request** optional `checkpoint` on `POST /generate`, validated in `parseGenerateBody`
  (non-empty, ≤200 chars, no path traversal → 422). Precedence: **request > config > template**.
- **Engine** `setNodeCheckpoint` overrides base node `"4"` on the cloned graph (both workflows);
  composes with the LoRA (node `"20"`) and IP-Adapter chains. The **refiner** checkpoint (node
  `"11"`) is left stock. Unknown name → ComfyUI `node_errors` → existing clean 503 (no pre-flight).
- **/health** now returns `checkpoint` (effective default) + `checkpoints` (installed list, via a
  new `listCheckpoints` probe). `src/ui.html` gained a **Model dropdown** populated from it.
- Tests: `npm run test:unit` → **50 pass** (10 new: engine node-"4" override incl. refiner-untouched
  + LoRA-compose; server config-default/request-override/422/health). Mock gained a `checkpoints`
  option + a `/object_info/CheckpointLoaderSimple` route.
- Docs: [docs/developer-reference.md](docs/developer-reference.md) (config field, `POST /generate`
  param, /health fields, test-UI note), ADR-0004. Branched off `master`; unrelated to the
  IP-Adapter `referenceStart` work in progress on another branch.

### Prior — real sample images (merged, PR #15)
Follow-up to the merged documentation pass (PR #14): the SVG placeholders were replaced with
**actual generated images** produced by the live service on this box.

- Generated via a new committed, reproducible script **`tools/generate-sample-images.py`** (Pillow +
  stdlib; points at a running imagegen-service): the **eight style tiles** (same "stone bridge over
  a misty gorge" prompt across styles + a few varied prompts), a **character-consistency montage**
  exercising the **IP-Adapter** reference-image path (one portrait → three scenes, same face), and a
  **composed banner** (an oil-painting hero with the title overlaid).
- Swapped every `docs/images/*.svg` reference in `README.md`, `docs/gallery.md`, and
  `docs/using-it.md` to the new `.png`; deleted the placeholder SVGs and the now-done
  `EXAMPLES-TODO.md`; updated the "placeholder / next pass" wording to "generated by the service".
- Docs-only + a tools script — no `src/` changes; `npm run test:unit` untouched.

### Prior — documentation pass (merged, PR #14)
Reframed the docs for a curious, non-technical reader while keeping the developer material intact:
`README.md` became a **friendly front door** (banner, example grid, honest "what you need" incl. a
brief **Macs-unsupported** note, three-step get-started, 12-style table, related-projects table, MIT
license). All the deep API/config/auth/systemd detail moved into **`docs/developer-reference.md`**,
which also documents the two previously-undocumented pieces: the **IP-Adapter reference-image**
params (`references`, `referenceStrength`) and the **quality-tier** table. `docs/using-it.md` gained
a plain-language **"Make a character look consistent"** section; `docs/README.md` became the docs
index; added **`docs/gallery.md`**, **`LICENSE`** (MIT), and GitHub description + topics. That PR was
based on `add-generate-size`, so it also landed the previously-unmerged **IP-Adapter** commit.

## Prior state — width/height
`POST /generate` now accepts optional **`width`/`height`** (merged, PR #13): validated in
`parseGenerateBody` (integer, multiple of 8, in `[256, 2048]`, else 422) and applied to the
`EmptyLatentImage` node `"5"` in `generateImage` (`setNodeSize`), **defaulting to 1024×1024** when
omitted — fully backward-compatible. Requested by the scriptorium bakery (its cycle S10a needs
832×1216 SDXL plates; DESIGN §10). Engine otherwise unchanged; no new deps; `process.env` still
absent. Tests: `engine.test.ts` + `server.test.ts` cover the sized graph, the 1024 default, and a
422 on a non-multiple-of-8 dimension (`npm run test:unit` → 36 pass).

## Prior state
Slice 2 built (PR open for review): deployment + optional auth + docs, per ADR-0001's
Consequences. **The generation engine is untouched** — `src/engine.ts`, `src/style-loras.ts`,
and `src/workflows/*` are unchanged; this slice adds only an HTTP-layer auth gate, a systemd
unit, and docs.

- systemd: `deploy/imagegen-service.service` — runs `tsx src/index.ts` (what `npm start` runs) as
  the same user next to `comfyui.service`, restart-on-failure, enable-on-boot. No secrets/paths in
  the unit; the app reads `config.json`. **ExecStart invokes node by ABSOLUTE path**
  (`/home/kb/.nvm/versions/node/v22.22.3/bin/node --import tsx src/index.ts`) with a matching
  `Environment=PATH`, because systemd has a bare PATH and can't see nvm — the earlier
  `ExecStart=/usr/bin/npm start` crash-looped with status=203/EXEC. The node path is
  nvm-version-specific: **update ExecStart + Environment=PATH when node is upgraded** (README has
  the caveat). The same fix applies to Chronicle's `chronicle.service` on the i5 server.
  `systemd-analyze verify` passes clean. Verified live: running the exact ExecStart command came up
  and stayed up, `/health` returned `comfyuiReachable:true` + all 12 LoRAs. (The `sudo cp` +
  `daemon-reload` + `restart` to swap the installed unit must be run by a human — sudo isn't
  available to the headless cycle.)
- Auth (ADR-0002): `config.auth = { enabled, token }`, **OFF by default** (behavior identical to
  Slice 1). When enabled, `/generate` + `/styles` require `Authorization: Bearer <token>` (bare
  401 on miss/mismatch, constant-time compare via `node:crypto`, fail-closed on empty token);
  `/health` is never gated. Auth lives entirely in `src/server.ts` (`isAuthorized`) + `config.ts`.
- README: full usage — remote-GPU story, `/generate|/styles|/health` with curl (incl. a
  bearer-token example), config setup, and the systemd install/operate steps.
- Test UI (additive dev convenience, no ADR): the server serves a self-contained page at `GET /`
  and `GET /index.html` (`src/ui.html`, inline CSS + vanilla JS, no deps/build). Read once into
  `UI_HTML` in `src/server.ts` and served **ungated** so a token can be entered into it; the
  engine/API/contract are untouched. On load it hits `/health` + `/styles`, and its form POSTs to
  `/generate` (optional bearer-token field → works when `auth.enabled`). README documents it.
- Tests: `npm run test:unit` — **32 passing** (29 prior + 3 UI cases: `GET /` 200 text/html with
  the form, `/index.html`, and `/` ungated under auth), CI-safe.
- Verified live on this box (ComfyUI 0.27.0): auth-off parity works; auth-on → `/generate` 401
  without header, real PNG with the correct token; `/styles` 401→200; `/health` open either way.

### Slice 1 (merged, PR #2) — for reference
Slice 1 built the standalone ComfyUI-fronting image service per ADR-0001. Clean-room extraction
of Chronicle's local backend — no import of / dependency on Chronicle.

- Stack: TypeScript on Node, run via `tsx`. Node built-in `http` + `fetch`. No web framework,
  no runtime deps (devDeps: tsx, typescript, @types/node).
- Endpoints: `POST /generate` (JSON in → PNG bytes; 200/422/503), `GET /styles`, `GET /health`.
- Engine (`src/engine.ts`): quality tier → workflow selection, style → LoRA recipe injection
  (trigger + LoRA node "20" + strength, `noRefiner`), ComfyUI POST /prompt → poll
  /history-by-own-prompt_id → fetch /view, never-throw + tier-aware timeouts.
- Config (`src/config.ts`): file-based only (`config.json` git-ignored, `config.example.json`
  committed). No env vars (`grep -rn process.env src/` is empty). Defaults: host 0.0.0.0,
  port 8189, comfyui http://localhost:8188.
- Two resolved API choices (not pinned by the ADR): caller `negativePrompt` is *appended* to the
  workflow's baseline negatives; when `seed` is omitted a random 32-bit seed is used.
- Tests: `npm run test:unit` — 22 passing, CI-safe (mocked ComfyUI, no GPU), including the
  critical concurrency test (poll-by-own-prompt_id, no cross-delivery).
- Verified live on this box against real ComfyUI 0.27.0: /generate returned a real 1024×1024
  styled PNG; /health shows reachable + all 12 recipe LoRAs; /styles lists the 12 presets.

## Next up
Slices 1 and 2 are complete, plus width/height, IP-Adapter reference images, and the docs pass.

- Sample images are done. To refresh them (e.g. after adding a style), re-run
  `python3 tools/generate-sample-images.py` against a live service.
- Optional future: point Chronicle at this service instead of ComfyUI directly (swap transport,
  keep caption/grounding) — a separate Chronicle-side slice.

## Open questions / blocked
None.
