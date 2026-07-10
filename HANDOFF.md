# Handoff

## Current state
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
- Tests: `npm run test:unit` — **29 passing** (22 existing + 7 auth cases), CI-safe.
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
Slices 1 and 2 are complete. No further planned slices.

Optional future: point Chronicle at this service instead of ComfyUI directly (swap transport,
keep caption/grounding) — a separate Chronicle-side slice.

## Open questions / blocked
None.
