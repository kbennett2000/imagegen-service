# Handoff

## Current state
Slice 1 built (PR open for review): the standalone ComfyUI-fronting image service per
ADR-0001. Clean-room extraction of Chronicle's local backend — no import of / dependency on
Chronicle.

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
Slice 2 (deployment), per ADR-0001 Consequences — intentionally NOT in slice 1:
- systemd unit for auto-start.
- optional shared-token auth toggle (config-driven).
- expanded README + curl usage docs.

Optional future: point Chronicle at this service instead of ComfyUI directly (swap transport,
keep caption/grounding) — a separate Chronicle-side slice.

## Open questions / blocked
None.
