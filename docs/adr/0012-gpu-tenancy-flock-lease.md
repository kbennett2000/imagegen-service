# ADR-0012: Shared-flock GPU tenancy lease

## Status
Accepted

## Context
One GPU on the box serves two tenants: the ComfyUI this service fronts (an SDXL/Wan checkpoint,
~6.9 GB resident whenever it's warm) and text-transform-service's Ollama 9B model, which wants the
rest of the 12 GB card. They can't co-reside comfortably — when ComfyUI holds its slab warm, the 9B
evicts/reloads per call (~27–30 s each) and a burst of story-cover calls never drains inside its
request window (413 over_budget / timeouts).

The earlier plan pushed the fix onto callers: the cron/orchestrator was to POST ComfyUI `/free`
before its TTS window. The owner reversed that — a client should never drive another service's model
lifecycle. GPU exclusivity moves **server-side** into the two services, which coordinate through one
shared advisory file lock. Callers (Chronicle, brickfeed, …) keep calling the HTTP APIs exactly as
today; the lock is invisible to them. This service today is concurrent and unbounded and delegates
GPU serialization to ComfyUI's internal queue (ADR-0001 §Concurrency) — there was no lock, no
`/free`, and no VRAM management anywhere. This ADR adds the first ones for this service's half.

The full contract shared with text-transform-service lives in the GPU-tenancy spec; this ADR records
the imagegen-service implementation of it.

## Decision

### One advisory lock, refcounted, held-while-busy
A single `flock(2)` exclusive lock on a well-known lockfile — `/run/gpu-tenant.lock` (tmpfs, cleared
on reboot; falls back to `/var/lock/gpu-tenant.lock`) — that this service and text-transform-service
both honor. Whoever holds it owns the whole GPU: it loads its models, drains its queued work under
that one lease (hold-and-drain), frees its own VRAM, then releases. A `GpuLease` (`src/gpu-lease.ts`)
keeps an in-flight counter of GPU jobs; it acquires the flock on 0→1, **holds while the count is >0**
letting requests keep pipelining into ComfyUI's queue as before, and releases after the count returns
to 0. A batch of `/generate` calls therefore loads the checkpoint **once** and drains under one lease.

### Guarded paths
The lease wraps the two GPU-touching request paths — `POST /generate` (`generateImage`) and
`POST /animate` (`animateImage`) — in the server handlers via `lease.run(() => …)`. It sits *around*
the existing engine dispatch; the per-request `prompt_id` isolation inside the engine
(ADR-0001 §Concurrency) is unchanged. `POST /stitch` (ffmpeg/CPU), `GET /health` (must never block),
and `GET /styles` are **not** gated.

### Free before release (ordering is the cross-service contract)
When the in-flight count returns to 0 for `idleGraceMs` — or `maxHoldMs` is reached — the lease POSTs
`{comfyui.url}/free` `{"unload_models":true,"free_memory":true}` (a new `freeComfy()` in
`src/engine.ts`, reusing `comfyBase()`), **and only then** releases the flock. Freeing before release
guarantees the next tenant finds clear VRAM on acquire. `/free` targets the fronted ComfyUI (:8188),
never this service's own port (:8189). The idle grace bridges a near-immediate follow-up (e.g.
generate→animate) so it reuses the warm checkpoint instead of reloading.

### MAX_HOLD fairness — non-preemptive
`maxHoldMs` bounds how long one tenant holds before yielding, but **never interrupts a running job**.
The lease only frees+releases when the in-flight count is 0; past `maxHoldMs` it releases promptly
(skipping the idle grace) to give the peer a turn, instead of bridging further arrivals. A single Wan
video can run up to ~20 min (`ANIMATE_TIMEOUT_MS`) and legitimately holds the whole time — so the
default `maxHoldMs` is **21 min (1_260_000)**, above that timeout, so a full render never self-yields
mid-video. (A long continuous *image* stream that keeps the count >0 past `maxHoldMs` holds until the
first gap, then releases — accepted.)

### Fail-open
The lock is a throughput optimization, not a safety gate. If the lockfile can't be opened/locked, or
the acquire times out (peer stuck-but-alive past its own MAX_HOLD), the lease logs a warning and
proceeds **without** the lock. On the fail-open path it never held the lock, so it does **not** free
the shared VRAM. `gpuLock.enabled:false` is a kill-switch with the same bypass shape.

### Crash-safety is free
The kernel releases an `flock` when the holding process dies — no TTL, heartbeat, or reaper. A
crashed tenant can never wedge the GPU.

### Lock primitive: shell out to flock(1) — no npm dependency
Node has no built-in `flock`. Rather than add the first-ever runtime dependency (`fs-ext` is a native
addon; `proper-lockfile` is mkdir+mtime, not a real kernel lock), the provider shells out to the
`flock(1)` system tool — consistent with ADR-0010's precedent that invoking a system binary via
`child_process` is **not** an npm/runtime dependency (the "no runtime deps beyond tsx/typescript"
invariant is about package.json, not system tools). `grep '"dependencies"' package.json` stays empty.
A long-lived child holds the lock fd for its whole lifetime:

```
flock -w <secs> -x <path> -c 'printf R; exec cat'
```

`flock` takes `LOCK_EX`, then runs the command, which prints `R` (⇒ acquired) and `cat` blocks on
stdin. Closing the child's stdin makes `cat` hit EOF and exit → `flock` exits → the kernel drops the
lock. If **this** process dies (even SIGKILL) the kernel closes the pipe's write end → `cat` EOF → the
same release chain runs, which is why the child reads our pipe rather than sleeping. The provider is
an injectable `LockProvider` interface, so tests drive the lease with an in-memory fake (no filesystem,
no real flock); a skipped-when-absent smoke test exercises the real `flock(1)`.

### Config (`gpuLock`, file-based, no env)
A new `gpuLock` block in the JSON config (ADR-0001's no-env invariant preserved): `path`
(byte-identical to text-transform-service's), `maxHoldMs` (1_260_000), `idleGraceMs` (5_000),
`acquireTimeoutMs` (120_000), `enabled` (true). Picked up automatically by the existing `deepMerge`.

### Observability
Each lease logs its lifecycle under a short per-lease id: `acquired`, `drained N job(s)`,
`freed comfyui (ok|failed)`, `released`, plus every `fail-open (<reason>)` and `acquire-timeout`.

## Consequences
- **ComfyUI goes cold between imagegen batches.** Freeing on release means the next batch (from any
  client) pays a one-time checkpoint reload. Hold-and-drain keeps it to once per batch, not per image
  — the deliberate trade: a warm-always ComfyUI is exactly what starves TTS today.
- **A long video blocks the peer.** While `/animate` holds the lease (up to ~20 min), TTS waits and
  may hit its own busy/queue path. Correct — the GPU is genuinely busy. Mitigation is scheduling, not
  preemption (out of scope for the lock).
- **Cross-service coupling is minimal and explicit.** Only three things must match text-transform-
  service exactly: the **lockfile path**, the **free-before-release ordering**, and the **fail-open**
  semantics. Timing knobs differ (our `maxHoldMs` is much larger because of video). Changing the
  lockfile path or lease protocol requires updating both services in lockstep.
- **No new dependency, no new daemon, no caller involvement.** flock gives crash-safety and rough
  FIFO fairness from the kernel for free.
- **Additive.** No change to the engine's per-request `prompt_id` isolation, the SDXL/Wan render
  paths, or `/stitch` / `/styles` / `/health`.
