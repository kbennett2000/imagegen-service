# ADR-0018: Re-scan ComfyUI models without a root restart

## Status
Accepted

## Context
ComfyUI reads its model list **once, at startup**, and caches it. Files added — or a second drive
that mounts — *after* ComfyUI is running do not appear in the Model dropdown until ComfyUI re-scans.
The service is a pure pass-through here (ADR-0017): its `GET /health` only mirrors ComfyUI's
`/object_info`, so a stale ComfyUI list looks, from the service, like a missing model.

This bit us concretely. On a split-drive setup (ADR-0017) the second drive is a desktop `udisks`
auto-mount under `/run/media/<user>/<label>`, which can land a few seconds *after* the
`comfyui.service` systemd unit starts at boot. When that happens ComfyUI scans an **empty** second-
drive folder and every model on it stays invisible — even after the drive is fully mounted — with the
files plainly present on disk. The historical advice ("restart ComfyUI") is correct but requires
`sudo` and interrupts work, and it's easy to restart the *wrong* thing (the service, not ComfyUI).

We wanted a one-command re-scan that:
- needs **no root** (the deploy runs `comfyui.service` as the login user; `systemctl restart` still
  needs a password), and
- makes it obvious what changed (before/after counts, newly visible files).

## Decision

### A `scripts/rescan-models.sh` helper that reboots ComfyUI in-process
ComfyUI-Manager (already installed here) exposes `POST /manager/reboot`. In the non-`comfy-cli`
launch this deploy uses, that handler re-executes the process in place via `os.execv` — same user, no
`sudo`, and ComfyUI comes back with a fresh filesystem scan. The helper:

1. reads the current checkpoint enum from `/object_info/CheckpointLoaderSimple` (bails if ComfyUI is
   unreachable — nothing to rescan);
2. `POST`s `/manager/reboot` with a JSON content-type (clears the Manager's cross-origin form guard).
   A dropped connection (`http_code` 000) is **success** — the process re-execed mid-response; only a
   real HTTP status is treated as failure: `403` (Manager `security_level` too high) or `404` (Manager
   not installed) print the `sudo systemctl restart comfyui.service` fallback instead of failing
   silently;
3. waits for ComfyUI to answer again (`curl --retry-connrefused`, no sleep), then prints
   `before → after` counts and the newly visible checkpoints.

Flags mirror the other scripts (`--host`, `--service`, `--timeout`, `--dry-run`, `-h`); config is
flags/env only (`COMFYUI_URL`, `IMAGEGEN_URL`), consistent with the file-config, no-`process.env`-in-
`src/` house rule (this is ops tooling, not `src/`).

### Durable ordering fix documented, not automated
The root cause of the boot race is ordering: ComfyUI must start **after** the model drive is mounted.
The reliable fix is a stable `/etc/fstab` mountpoint for the drive (with `nofail`) plus
`RequiresMountsFor=<that path>` on `comfyui.service`. We **document** this in `docs/adding-models.md`
§8 rather than shipping it, because it's host-specific, needs root to apply, and depends on the user's
mount layout — and a `udisks` auto-mount under `/run/media` is not a boot-time mount unit, so ordering
against that path directly isn't reliable. The helper is the everyday tool; the fstab change is the
one-time hardening.

## Consequences
- New models (and a re-mounted second drive) become visible with one no-`sudo` command; no more
  restarting the wrong service.
- The helper depends on ComfyUI-Manager and its `security_level` allowing `/manager/reboot`; both hold
  on this deploy, and the fallback message covers the case where they don't.
- `scripts/fetch-missing-checkpoints.sh`'s closing hint now points at `rescan-models.sh` instead of
  "restart ComfyUI".
- No `src/` change and no new runtime deps; nothing about the service's request path changes.
