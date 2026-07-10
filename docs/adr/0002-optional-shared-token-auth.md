# ADR-0002 — Optional shared-token auth (config-gated, open by default)

## Status
Accepted (deployment slice)

## Context
ADR-0001 set `server.host` to `0.0.0.0` — LAN-exposed by design — and explicitly deferred "an
optional shared-token auth toggle" to the deployment slice. The service fronts a ComfyUI that is
itself already unauthenticated on the LAN (see `comfyui.service`: `--listen 0.0.0.0`), and
Chronicle likewise runs open on the trusted home LAN. So the baseline stance is intentional: on a
trusted network, the service is fully open and requires no credentials.

But the whole point of this service is to be reachable across the LAN, and a LAN is not always
exclusively trusted — a guest phone, an IoT device, or a second household segment might join. We
want a low-friction way to require a shared secret *when that happens*, without changing anything
for the common trusted-LAN case.

## Decision

### Config-gated, OFF by default
Add an `auth` section to config:
```json
"auth": { "enabled": false, "token": "" }
```
- `enabled: false` (**default**) → behavior is identical to the Slice-1 open service. No header is
  read, nothing is required. This preserves the ADR-0001 open-by-default stance verbatim.
- `enabled: true` → `/generate` and `/styles` require `Authorization: Bearer <token>` matching
  `auth.token`.

The token lives only in the git-ignored `config.json` (never in `config.example.json`, never in
the systemd unit, never in an env var — ADR-0001's no-env-vars invariant holds).

### What is gated, what is not
- **`/generate`** and **`/styles`** are gated when auth is enabled (the value-producing and
  discovery endpoints).
- **`/health` is NEVER gated** — monitoring / liveness probes must keep working without the token.

### No information leak
A failed check returns a bare `401 { "error": "unauthorized" }`. The response never distinguishes
"no token supplied" from "wrong token" from "auth not even enabled." Comparison is constant-time
(`node:crypto` `timingSafeEqual`, length-guarded) — no new runtime dependency.

### Fail closed on misconfiguration
If `enabled: true` but `token` is `""`, every gated request is rejected (401) rather than
accepting an empty bearer. Startup logs a warning so the misconfiguration is visible.

## Consequences
- Trusted-LAN users see zero change: open by default, matching ComfyUI/Chronicle.
- Turning on auth is a two-line config edit + restart; callers add one header.
- `/health` remains a dependable unauthenticated liveness signal for systemd/monitoring.
- This is deliberately a *shared* token (one secret for the whole service), not per-caller
  identity — appropriate for a small home-LAN service. Per-caller keys/rotation are out of scope
  and can be a later ADR if a real multi-tenant need appears.
