# Handoff

## Current state
**Multi-model video dispatch + LTX-Video — Slice 3 of the "wide variety of SFW models" effort
(ADR-0015, PR open for review; based on current master, independent of Slices 1/2).** `/animate` was
Wan-only; it now dispatches across video models by a `model` id. **Wan behavior is byte-identical and
the default — no caller breaks.**

- **Registry** `src/video-models.ts`: `VIDEO_MODELS: Record<AnimateModel, VideoModelSpec>`. A spec =
  `{label, files (loaderClass/inputName/file/subdir to preflight), fetchHint, render(params)->graph}`.
  Pure data + renderers; imports no engine code (no cycle).
- **Dispatch**: `animateImage` resolves the spec from `params.model` (default `wan-5b`), preflights
  `spec.files` via a generalized `videoModelsMissing(base, fetchFn, files)`, renders via `spec.render`.
  The transport (upload → /prompt → poll by own id → /view), never-throw, and 20-min timeout are
  unchanged. `wanModelsMissing` kept as a thin wrapper (smoke script + tests).
- **Validation**: `parseAnimateBody` 422s a `model` not in `ANIMATE_MODELS`.
- **New model `ltxv`** — LTX-Video 2B: `src/ltxv-workflow.ts` + `src/workflows/ltxv-i2v.json`
  (CheckpointLoaderSimple + CLIPLoader type=ltxv → LTXVImgToVideo → LTXVConditioning/LTXVScheduler +
  KSamplerSelect → SamplerCustom → VAEDecode → CreateVideo/SaveVideo). LTX grid: dims ×32,
  **frames 8n+1** (Wan is 4k+1); defaults 768×512, 97 frames, 24 fps. Two files (checkpoint bundles
  its VAE + a separate T5), both ungated HF → `scripts/fetch-ltxv-models.ts` (pure-HF, reuses the wan
  script's `planDownloads`; ~11.5 GB). Sizes HF-API-verified.
- **Tests:** `npm run test:unit` → **130 pass** (116 prior + `video-models.test` + LTX animate/fetch
  tests). `process.env` absent from `src/`; no runtime deps. Mock advertises the LTX files by default.
- **NOT render-verified here** (no weights/nodes on this box) — like the Wan foundation, the LTX
  template's node ids/classes/sampler come from the canonical ComfyUI LTXV i2v template; a
  real-ComfyUI smoke check is the remaining step. Wan 2.2 14B deferred (dual-expert complexity).
- **Branch note:** based on current master (has `/animate`); Slices 1/2 were off older master and are
  independent PRs. This slice needs no Civitai auth (LTX is ungated HF).

### Prior — POST /animate — Wan 2.2 image-to-video endpoint (ADR-0009)
**POST /animate — Wan 2.2 image-to-video endpoint (ADR-0009, PR open for review).** Cycle 2 of 2.
Exposes the ADR-0008 pipeline through the service: a still + prompt in → mp4 bytes out. **`generateImage`,
the SDXL templates, and the `/generate` path are untouched** — the video path is purely additive.

- **Endpoint** `POST /animate` (auth-gated like `/generate`): JSON `{ image (base64, required), prompt
  (required), negativePrompt?, seed?, width?, height?, frames?, fps? }` → `video/mp4` (200/422/503).
  `parseAnimateBody` validates (frames `[1,121]`, fps `[1,120]`, dims `[256,2048]` int); the engine
  owns the ×32 / 4k+1 snapping. `sendBytes` returns the video with its derived content-type.
- **Engine** `animateImage` (in `src/engine.ts`, beside `generateImage`, reusing its transport):
  preflight `wanModelsMissing` (hard fail → 503 with the exact files to fetch, since animation can't
  degrade), upload still, `renderWanWorkflow`, POST /prompt → poll by own prompt_id → /view. **20-min
  poll budget** (`ANIMATE_TIMEOUT_MS`) absorbs the render + the SDXL↔Wan model-load pause; longer /view
  timeout for the multi-MB mp4. Generalized `findOutputFile` (SaveVideo's output key varies by build)
  + `contentTypeFor`. Refactored the three `listX` probes onto a shared `objectInfoOptions`.
- **/health** gained `wan: { ready, missing }` (best-effort; skipped when ComfyUI unreachable).
- **Tests:** `npm run test:unit` → **101 pass** (89 prior + 12 new: animate happy-path/param-flow/
  missing-models/exec-error, wanModelsMissing, and server 200/422×2/503/401→200/health). MockComfy now
  advertises the Wan loaders (UNETLoader/CLIPLoader/VAELoader, defaults present, settable empty) + an
  `outputFilename` override for the video content-type path. `process.env` still absent from `src/`.
- **Verified live against real ComfyUI** (models NOT downloaded on this box): ran the updated server on
  an ephemeral port (the systemd instance on :8189 still runs old code — see below). `/health` →
  `wan.ready:false` listing all three missing files; `POST /animate` → **503** with the actionable
  message; missing-image → **422**. Correct, honest, no fabricated render.
- **⚠️ The running service on :8189 is a systemd unit (`imagegen-service.service`, enabled) serving the
  repo working tree, still on OLD code.** Restarting it needs sudo, which the headless cycle lacks
  (`sudo -n` → "interactive authentication required"). To pick up this branch after merge, a human runs:
  `sudo systemctl restart imagegen-service`. (No code change needed — it runs `tsx src/index.ts` from
  the working tree.)
- **To actually render video:** update ComfyUI → `npx tsx scripts/fetch-wan22-models.ts` → restart
  ComfyUI → `POST /animate` (or `scripts/smoke-wan22.ts` to bypass the service).
- **Future:** 14B-GGUF as a higher-quality tier (ADR-0008); an async job API only if concurrent/batch
  animation becomes real (ADR-0009 chose synchronous to match `/generate`).

### Prior — Wan 2.2 image-to-video foundation (ADR-0008, merged PR #21)
Cycle 1 of 2 — proves the
image-to-video pipeline OUTSIDE the service before Cycle 2 adds a `POST /animate` endpoint. **No
existing endpoint, SDXL template, or engine path changed.**

- **Model: Wan 2.2 TI2V 5B.** Correction to the cycle brief: the 5B ships **fp16-only**
  (`wan2.2_ti2v_5B_fp16.safetensors`, ~10 GB) — there is **no fp8 5B** in the official Comfy-Org
  repo; fp8_scaled variants are all 14B. The fp16 5B is exactly what fits 12 GB with no quant tricks,
  so the pin is correct and the ADR records the discrepancy. 14B-GGUF noted as a future quality tier.
- **`scripts/fetch-wan22-models.ts`** — idempotent download (skip-by-exact-size) of the three files
  into a `--models-root` (default `~/comfyui/models`): the 5B diffusion model, `wan2.2_vae.safetensors`,
  and `umt5_xxl_fp8_e4m3fn_scaled.safetensors`. Sizes verified against HF. `--dry-run` supported.
  Transfers via `curl -L -f -C -` (resume). Pure `planDownloads` is unit-tested with a mocked stat.
- **`src/workflows/wan22-ti2v-5b-i2v.json`** + **`src/wan-workflow.ts`** (`renderWanWorkflow`) — the
  Wan graph parameterized BY NODE ID like SDXL, pure clone-per-call. UNETLoader"37"→ModelSamplingSD3
  "48"(shift 8)→KSampler"3"(euler/simple, cfg5, steps30); CLIPLoader"38"(type wan); LoadImage"52"→
  **ImageScale"53"**(scales arbitrary input to target res)→Wan22ImageToVideoLatent"55"→VAEDecode"8"→
  CreateVideo"57"→SaveVideo"58"(mp4). Defaults **1280×704, 24fps, 121-frame cap** (frames snapped to
  the 4k+1 grid, dims to mult-of-32).
- **`scripts/smoke-wan22.ts`** — `--image`/`--prompt`/`--frames`/`--size`; uploads, renders, submits
  DIRECTLY to ComfyUI (bypassing the service), polls by own prompt_id, writes the mp4, prints elapsed
  + path. Fails loudly if ComfyUI is unreachable or any of the three models isn't advertised by
  `/object_info`. Never fabricates success.
- **Verified live on this box (ComfyUI reachable, Wan nodes present):** the smoke script was run and
  **failed loudly and correctly** — the ~18 GB of Wan models are NOT downloaded on this box, so it
  reported the three missing files + pointed at the fetch script (exit 1). The fetch script `--dry-run`
  printed the correct URLs/destinations. **A full render was not possible without downloading the
  models** (a documented manual step); no video was fabricated.
- **Tests:** `npm run test:unit` → **89 pass** (76 prior + 13 new: template injection incl.
  scaler-feeds-latent, frame/dim snapping, negative-append, fresh-clone; + fetch skip/redownload/mixed
  logic with mocked stat). `process.env` still absent from `src/`.
- **Next cycle (Cycle 2):** `POST /animate` endpoint reusing `renderWanWorkflow`. Needs a **video-tier
  timeout** (minutes) that also absorbs the **SDXL↔Wan model-load pause** on the first job after a job-
  type flip (both share the 12 GB card; see ADR-0008 Consequences). To actually render: update ComfyUI,
  run `scripts/fetch-wan22-models.ts`, restart ComfyUI, then `scripts/smoke-wan22.ts`.

### Prior — IP-Adapter conditions identity, not composition (ADR-0007)
**IP-Adapter conditions identity, not composition (ADR-0007, PR open for review).** `applyIPAdapter` injected the
reference across the *entire* denoising schedule (`start_at: 0.0`) and fed `plus-face` an
**uncropped** bust. Both are wrong for a face adapter, and a downstream caller found out expensively:
one of its character portraits happened to render as two men in uniform against red curtains, and
**84 illustrations came back as near-copies of it** — same figures, same uniforms, same curtains —
no matter what their prompts asked for. The early high-noise steps decide layout and *figure count*;
letting the adapter own them meant it dictated composition, not just likeness.

- **`start_at` now defaults to `0.30`**, so composition belongs to the text prompt and identity
  lands afterwards. The old mitigation for this exact symptom was a lowered `weight` (the code
  comment read *"a bust portrait reference at higher weight collapses every scene into a bust"*) —
  the right observation, the wrong dial.
- **Head-crops the reference** via `PrepImageForClipVision` (`crop_position: "top"`) as graph node
  **25**, between `LoadImage` (21) and `IPAdapterAdvanced` (24). Probed with a generalised
  `nodeAvailable()`; a host without it conditions on the raw reference and still renders.
- `weight_type` `"linear"` → **`"ease in-out"`**; default `weight` 0.55 → **0.5**.
- New optional request field **`referenceStart`**, validated to `[0, 0.5]` (422 outside), beside the
  existing `referenceStrength`. File-config/request-driven only — still no env vars.
- `npm run test:unit`: **76 passing**, CI-safe. `MockComfy` gained a `nodes` option so both the
  crop-present and crop-absent paths are covered.

### Prior — image upscaling (merged, PR #19)
**Image upscaling (merged, PR #19).** Optional `upscale` factor on `POST /generate` enlarges the
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
  upscale model.

### Prior — image-to-image (merged, PR #18)
Optional `initImage` + `denoise` on `POST /generate` (ADR-0005), with matching test-UI controls.
Independent of the `referenceStart` work above — one seeds the sampler's latent, the other schedules
identity conditioning — and they compose.

### Prior — selectable base checkpoint + UI (merged, PRs #16/#17)
The SDXL base checkpoint is no longer hardcoded to `sd_xl_base_1.0.safetensors`; it is selectable
(ADR-0004), fully backward-compatible.

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
  param, /health fields, test-UI note), ADR-0004. Branched off `master`; the IP-Adapter `referenceStart`
  work above landed after it and was rebased on top (its ADR renumbered 0004 -> 0006).

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
- Tests: `npm run test:unit` — 55 passing, CI-safe (mocked ComfyUI, no GPU), including the
  critical concurrency test (poll-by-own-prompt_id, no cross-delivery).
- Verified live on this box against real ComfyUI 0.27.0: /generate returned a real 1024×1024
  styled PNG; /health shows reachable + all 12 recipe LoRAs; /styles lists the 12 presets.

## Next up
Slices 1 and 2 are complete, plus width/height, IP-Adapter reference images, the docs pass, and
ADR-0006 (identity-only conditioning).

- **`docs/developer-reference.md` documents `references`/`referenceStrength` but not
  `referenceStart`** — add it, and refresh the stated `weight` default (0.55 → 0.5).
- **Multi-identity conditioning is still unsolved.** `references` accepts up to 4 images but only
  the first is used, applied globally with no attention mask, so a two-person frame gives both
  people the reference's face. Needs regional/masked conditioning; the caller would supply regions.
- The character-consistency montage in `docs/images/` was generated under the old `start_at: 0.0`
  behaviour — regenerate it (`python3 tools/generate-sample-images.py`) against a live service.

- Sample images are done. To refresh them (e.g. after adding a style), re-run
  `python3 tools/generate-sample-images.py` against a live service.
- Optional future: point Chronicle at this service instead of ComfyUI directly (swap transport,
  keep caption/grounding) — a separate Chronicle-side slice.

## Open questions / blocked
None.
