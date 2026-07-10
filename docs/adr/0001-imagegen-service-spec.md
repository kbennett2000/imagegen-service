# ADR-0001 — imagegen-service: standalone ComfyUI-fronting image API

## Status
Accepted (initial build spec)

## Context
Chronicle generates images by talking to a local ComfyUI directly (POST /prompt, poll
/history, fetch /view), selecting a workflow by quality tier and injecting a style LoRA per a
recipe map. We now want OTHER LAN apps to share the same dev-PC GPU without each one
reimplementing that whole dance. Raw ComfyUI is a poor shared API (callers must embed full
workflow graphs, poll, and fetch). So we extract Chronicle's proven local backend into a thin
standalone HTTP service with a small, stable contract.

This service is a CLEAN-ROOM EXTRACTION: the logic from Chronicle's local backend is reference,
reimplemented here standalone. No import of or dependency on Chronicle.

## Decision

### Clean boundary — keep vs drop
KEEP (the reusable engine):
- quality tier -> workflow selection (fast / standard / high-with-refiner),
- style -> LoRA recipe: inject the trigger word into the prompt, set the LoRA node + strength,
  honor noRefiner (LoRA styles skip the refiner pass under quality=high),
- the full ComfyUI transport: POST /prompt, poll /history, fetch /view,
- never-throw + tier-aware timeout + graceful degradation.
DROP (caller's job, not the service's):
- prompt CONSTRUCTION (Chronicle's caption + entity grounding stays in Chronicle),
- SAVING to disk (the service returns PNG bytes; callers persist them).

### HTTP contract
POST /generate
  body: { "prompt": string (required),
          "negativePrompt"?: string,
          "style"?: string,
          "quality"?: "fast" | "standard" | "high"  (default "standard"),
          "seed"?: number }
  behavior: map style -> LoRA recipe (inject trigger into prompt, set LoRA node + strength,
    honor noRefiner); map quality -> workflow tier; run the ComfyUI dance; return the PNG.
  responses: 200 image/png (raw bytes)
           | 422 bad/missing params (JSON error body)
           | 503 ComfyUI unreachable/timeout (JSON error body)
  Never leak a stack trace.

GET /styles -> JSON: available style keys and which have a LoRA recipe (derived from the recipe
  map), so callers can discover options.

GET /health -> JSON: { comfyuiReachable: boolean, comfyuiUrl: string, lorasLoaded: string[] }
  (query ComfyUI /object_info; report which recipe LoRAs are actually present on the GPU host).

### Concurrency (CRITICAL — this service exists to be hit by multiple callers at once)
Two callers (e.g. Chronicle + another app) can hit /generate simultaneously. ComfyUI queues
work on the GPU correctly on its own; the risk is entirely on OUR side in how we track results.
Requirements:
- Each request MUST poll /history for ITS OWN returned prompt_id — NEVER "the latest history
  entry." Polling latest cross-delivers under concurrency (caller A receives caller B's image).
- Concurrent requests MUST NOT cross-deliver: request N always resolves to the PNG produced by
  request N's prompt_id, regardless of completion order.
- No global single-flight assumption: the service must handle overlapping in-flight requests.
  (Chronicle's local.ts may have masked this by being single-flight; do not carry that
  assumption over.)
- Test explicitly: two overlapping /generate calls with distinct prompt_ids each receive their
  own result even if the second finishes first.

### Config (file-based; NO env vars)
config.json (git-ignored) + config.example.json (committed):
- comfyui.url    default "http://localhost:8188"
- server.host    default "0.0.0.0" — LAN-exposed BY DESIGN (the service's whole purpose is to be
                 called across the LAN, matching the existing open-ComfyUI stance). Documented,
                 not accidental. (An optional shared-token auth toggle is deferred to the
                 deployment slice.)
- server.port    default 8189 (sits next to ComfyUI's 8188)
Config module loads config.json once at startup (fall back to config.example.json if absent),
returns a frozen/typed object. `grep -rn "process.env" src/` must be empty.

### LoRA files
The service does NOT hold LoRA files. ComfyUI loads them from ~/comfyui/models/loras/. The
service references them BY NAME in the injected workflow, exactly as Chronicle's backend does.
Reuse Chronicle's current recipe-map filenames/triggers/strengths verbatim.

## Consequences
- Chronicle can later be pointed at this service instead of ComfyUI directly (a small, OPTIONAL
  future Chronicle slice — swap the transport, keep caption/grounding). Chronicle keeps working
  against ComfyUI directly until then.
- Other LAN apps get a one-call POST {prompt,style,quality} -> PNG API.
- Deployment (systemd auto-start, optional token auth, expanded README/curl docs) is a separate
  second slice, intentionally not in this initial build.

## Verify (initial slice)
- Live against the real ComfyUI on this box:
  curl -X POST http://localhost:8189/generate \
    -d '{"prompt":"a stone bridge over a misty gorge","style":"oil painting","quality":"standard"}' \
    -o out.png   -> a real styled PNG.
- GET /health shows comfyui reachable + loras loaded; GET /styles lists the presets.
- Tests (CI-safe, mocked ComfyUI): style->LoRA injection (name/strength/trigger); quality->tier;
  noRefiner honored under high; unmapped style -> prompt-only graph; 422 on missing prompt; 503
  on ComfyUI failure; /styles + /health shapes; AND the concurrency test above (poll-by-own-
  prompt_id, no cross-delivery).
- grep -rn "process.env" src/ -> empty.
