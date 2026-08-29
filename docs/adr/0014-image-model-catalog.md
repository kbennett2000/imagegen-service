# ADR-0014: Image model catalog + checkpoint selection

## Status
Accepted

## Context
The service shipped with one base SDXL checkpoint (the workflow-template default, overridable per
request or via `config.comfyui.checkpoint`, ADR-0004) and twelve style LoRAs
([src/style-loras.ts](../../src/style-loras.ts)). Callers who wanted a different base model had to know
its exact ComfyUI filename — there was no way to discover what was available, and the installer only
fetched the one base checkpoint. To offer a *wide variety* of SFW image models, this ADR adds a
curated catalog of alternative SFW SDXL checkpoints and more style LoRAs, plus the selection
machinery to pick and discover them. It builds on ADR-0013 (Civitai-authenticated downloads) for the
sources that are Civitai-gated.

## Decision

### A checkpoint catalog, mirroring the style map
[src/checkpoints.ts](../../src/checkpoints.ts) adds `CHECKPOINTS`, a friendly-name → `{ file,
description }` map, shaped exactly like `STYLE_LORAS`. It lists the *extra* curated SFW SDXL
checkpoints; the stock SDXL base stays the workflow-template default and is intentionally not in the
catalog. All entries are single-file SDXL checkpoints the existing SDXL workflows load unchanged
(only node `"4"` is set — the refiner node `"11"` stays the stock SDXL refiner, which is valid for
any SDXL base, so quality=high keeps working).

### Selection by name or filename (backward compatible)
`resolveCheckpoint(value)` maps a catalog **name** (e.g. `"dreamshaper"`) to its ComfyUI filename;
any other value — an already-exact filename, or a name not in the catalog — passes through unchanged.
The server applies it in `handleGenerate` after the existing request>config precedence, so a
per-request `checkpoint` or `config.comfyui.checkpoint` may now be either a catalog name or a raw
filename. Existing callers that send filenames are unaffected. Validation is unchanged: the raw
request value is still checked by `parseGenerateBody` (path-traversal etc.) *before* resolution, and
an unknown-but-clean filename still fails cleanly downstream in ComfyUI (a 503), exactly as before.

### Discovery: `GET /checkpoints` + `/health`
A new `GET /checkpoints` endpoint (gated by the same optional token as `/styles`, and — like every
handler — never throwing) lists each catalog entry `{ name, file, description, installed }`, where
`installed` reflects ComfyUI's live `CheckpointLoaderSimple.ckpt_name` list (via the existing
`probeComfy`, which returns empty on failure rather than erroring). `/health` gains a
`checkpointsInstalled` array alongside `lorasLoaded`, so a monitor sees which catalog files are
actually on the box. The response notes that any installed checkpoint also works by exact filename.

### More SFW style LoRAs
`STYLE_LORAS` gains additional SFW artistic styles (each a `loraFile` + `trigger` + `strength` +
`noRefiner: true` + optional `extraNegatives`), and the previously-sourceless `watercolour` entry
gets a working source. No engine change — new entries flow automatically into `/styles`, `/health`
`lorasLoaded`, and the LoRA-injection path, exactly like the original twelve.

### Sourcing (curation + install)
Every catalog checkpoint and new LoRA gets a line in
[install/models.manifest](../../install/models.manifest) (`checkpoints|…` / `loras|…`), keeping the
one-place source list the installers read. Sources are curated **SFW-safe**, version-pinned, and
prefer an ungated Hugging Face mirror for robustness; Civitai-gated sources rely on ADR-0013's token.
A checkpoint's catalog `file` matches its manifest `dest-filename` exactly. The service never
downloads models itself — it references them by name; the installer (or a manual download) puts the
files under ComfyUI's `models/checkpoints` and `models/loras`.

## Consequences
- **Callers get a discoverable, curated set of SFW base models and more styles**, selectable by a
  stable friendly name, without needing to know ComfyUI filenames. Raw filenames still work.
- **No new runtime behavior risk to the render path.** The catalog is a lookup in front of the
  unchanged engine; checkpoint injection still touches only node `"4"`, and the refiner is untouched.
- **Bigger install.** Each extra checkpoint is ~6.5 GB. The installer already skips files already
  present and warns-and-continues on a failed source, so a missing model degrades to "not installed"
  (`/checkpoints` shows `installed:false`) rather than breaking the install.
- **The catalog is code, the sources are the manifest.** Adding a model is a `CHECKPOINTS`/
  `STYLE_LORAS` entry plus a manifest line — no engine or endpoint change.
