# ADR-0019: Group checkpoints by subfolder, reconcile the catalog by basename

## Status

Accepted

## Context

Checkpoints can live in subfolders of a ComfyUI `checkpoints/` root — most naturally when a user
organizes them (e.g. named subfolders) on a split drive (ADR-0017). ComfyUI lists each file *relative
to the root it was found under*, so the same file reads as `sd_xl_base_1.0.safetensors` when it sits
directly under a root and `sub/sd_xl_base_1.0.safetensors` when it sits in a subfolder of one.

Everything else in this service uses **bare** filenames: the curated catalog (`src/checkpoints.ts`)
and the workflow-template `ckpt_name`s. So when ComfyUI reports subfoldered names, three things break:

1. **`GET /checkpoints` / `/health` "installed" flags** compared with exact string equality, so every
   catalogued model whose file sits in a subfolder read as **not installed**.
2. **The default checkpoint** (`sd_xl_base_1.0.safetensors`, baked into the workflow templates)
   failed to load, because ComfyUI only had `sub/sd_xl_base_1.0.safetensors`.
3. **A catalog / bare override** (e.g. picking "animagine", which resolves to
   `animagine-xl-3.1.safetensors`) was sent to ComfyUI verbatim and rejected as not found.

Historically this surfaced the *opposite* way too: when models were subfoldered, the test UI's flat
"Installed" list printed ComfyUI's raw names (`sub/…`, `alt/…`) verbatim, which *looked* like folder
sections — but it was the prefix showing through, not grouping. Flattening the names (pointing the
root at the leaf subfolders) fixed recognition but removed that visual filing. Users want the folder
sections back **and** working recognition — the two were previously mutually exclusive.

## Decision

Reconcile catalog/template bare names against ComfyUI's reported names **by basename**, and group the
picker **by subfolder** — without depending on how the models dir happens to be arranged.

- **`src/checkpoints.ts`** gains three pure helpers:
  - `checkpointBasename(name)` — drops a forward-slash subfolder prefix.
  - `checkpointInstalled(file, available)` — installed test by basename.
  - `reconcileCheckpoint(desired, available)` — maps a bare name to the exact ckpt_name ComfyUI
    expects: exact match wins; else the first entry sharing the basename (recovering a subfolder prefix); else the desired value unchanged, so a truly absent model still yields ComfyUI's own clean
    "not found" rather than a silent swap.

- **`src/engine.ts`** (`generateImage`) fetches ComfyUI's live checkpoint list once and reconciles
  every `CheckpointLoaderSimple` node — the base node `4` (override *or* template default) and the
  refiner node `11` — so the exact subfoldered ckpt_name is injected. Best-effort: if the list can't
  be fetched, each node is left as-is (identical to prior behavior).

- **`src/server.ts`** flags `/checkpoints` and `/health` installed state by basename, and reconciles
  the reported effective `checkpoint` to the exact name ComfyUI advertises so a picker can mark it.

- **`src/ui.html`** groups the installed list into one `<optgroup>` per subfolder (`s`, `ns`, …),
  showing the clean basename; the option **value** stays the full name ComfyUI reported (what
  `/generate` needs). A bare install with no subfolder groups under "Installed", exactly as before.

The code tolerates **both** layouts, so whether the picker shows folder sections is purely a function
of how ComfyUI reports names — nothing re-breaks if the dir is flat.

## Consequences

- Subfoldered installs are now first-class: recognized, selectable, grouped, and generable — the
  default and the refiner included.
- **Operator step to see the grouping:** ComfyUI must *report* subfolders, i.e. point the
  `checkpoints:` root in `extra_model_paths.yaml` at the parent `checkpoints/` (so it recurses and
  prefixes `sub/…`, `alt/…`), not at the leaf subfolders. Restart ComfyUI. With this code deployed,
  the prefixed names both group in the UI and load correctly. (The flat-name workaround — listing the
  leaf subfolders as roots — also still works; it just shows no sections.)
- `generateImage` makes one extra `object_info/CheckpointLoaderSimple` GET per render to learn the
  live list. Negligible against a multi-second render, and it degrades to a no-op reconcile on
  failure.
- No new dependencies; no config schema change; no API-shape change (only the `installed` computation
  and the `checkpoint` value are more accurate).
