# ADR-0017: Split model storage across drives

## Status
Accepted

## Context
Model files are large — an SDXL checkpoint is ~6.5 GB, the Wan 2.2 5B set is ~18 GB — and they
accumulate on the main drive faster than anything else the service touches. Users want to keep some
models on a second disk while still generating with them, and without re-downloading files they've
already moved. Two independent concerns:

1. **The service UI must offer models from both drives.** The service is a pure pass-through here: it
   never scans a models directory. The Model dropdown is built from whatever ComfyUI reports via
   `GET /object_info/CheckpointLoaderSimple` (`ckpt_name` enum), fetched by `listCheckpoints` in
   `src/engine.ts` and surfaced through `GET /health`. So "show both drives" is entirely a question of
   what **ComfyUI** scans — not a service-code question.
2. **The download scripts must not re-fetch a moved file.** `scripts/fetch-missing-checkpoints.sh` and
   the shared `planDownloads` in `scripts/fetch-wan22-models.ts` (reused by `fetch-ltxv-models.ts`)
   each looked in only one models root. A file moved to a second drive looked "missing" and would be
   downloaded again.

## Decision

### Second drive via ComfyUI's `extra_model_paths.yaml` — no service change
ComfyUI's built-in `extra_model_paths.yaml` adds model search roots. Pointing it at a second drive's
`comfyui-models/` (with the standard `checkpoints/`, `loras/`, `vae/`, `diffusion_models/`,
`text_encoders/`, … subdirs) makes ComfyUI scan both locations; the new files then appear in the
service's dropdown with **no imagegen-service code change**, because the list is `/object_info`-driven.
A committed template lives at `install/extra_model_paths.example.yaml`. Files keep landing on the main
drive; the user moves them across manually as space runs low. A nested file is referenced by its path
relative to the type dir (`sdxl/foo.safetensors`) — the `checkpoint` field already accepts a
forward-slash subfolder (ADR-0004 validation).

### Scripts gain `--extra-root` (+ a bash env) for dedup only
Each fetch script learns about **additional model roots** it should also search before downloading:

- **`fetch-missing-checkpoints.sh`** — repeatable `--extra-root DIR` and colon-separated env
  `COMFYUI_EXTRA_MODEL_ROOTS`. Its recursive "already installed?" check now spans `dest` and each
  `<root>/checkpoints`. (Env is consistent with its existing `CHECKPOINTS_DIR`/`CIVITAI_TOKEN` usage.)
- **`fetch-wan22-models.ts` / `fetch-ltxv-models.ts`** — the pure `planDownloads` gains an
  `extraRoots` parameter and checks `<root>/<subdir>/<file>` at the exact expected size across all
  roots. Exposed via repeatable `--extra-root <dir>`. These scripts stay **flag-only** (no env),
  keeping the ADR-0001 file/flag-only stance they already document; the env var is bash-only.

Crucially, extra roots are **search-only**: downloads still target the primary root. Reorganizing
across drives stays a manual, deliberate act — the scripts just stop fighting it.

## Consequences
- **Models can live on any number of drives** and all show up in the UI, driven by ComfyUI's scan; the
  service and its endpoints are untouched (`grep -rn process.env src/` stays empty; no new deps).
- **No accidental re-downloads** of files moved to a second drive, via one shared "extra model root"
  concept across every fetch script.
- **New downloads still land on the main drive.** Filling the second drive is a manual move; that's by
  design (predictable, no silent placement rules), and documented.
- **Removable-mount caveat.** A udisks path (`/run/media/<user>/<label>`) exists only while mounted; if
  the drive is unmounted, those models leave the dropdown and the scripts stop seeing them. A permanent
  setup wants a stable `/etc/fstab` mountpoint — called out in `install/extra_model_paths.example.yaml`
  and `docs/adding-models.md`.
