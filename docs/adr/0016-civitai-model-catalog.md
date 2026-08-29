# ADR-0016: Popular SFW models from Civitai

## Status
Accepted

## Context
ADR-0013 added Civitai-authenticated downloads and ADR-0014 added a curated image catalog, but the
ADR-0014 picks were deliberately restricted to models with **ungated Hugging Face** mirrors (so they
worked without a key). Most of the well-known community SDXL models — the ones people actually reach
for — live on **Civitai** and are login-gated. With the API key now wired in (ADR-0013), this ADR
extends the catalog with a curated set of popular, verified **SFW** Civitai checkpoints and style
LoRAs.

## Decision

### Curated, SFW, version-pinned
Every entry was verified live against the Civitai REST API (`/api/v1/models`): `nsfw:false` at the
model level, `baseModel` = SDXL 1.0, and a real `.safetensors` primary file. Each manifest URL pins an
exact `modelVersionId` (`civitai.com/api/download/models/<id>`) so the download is reproducible.
Pony/Illustrious/Flux/SD-1.5 models were excluded (SDXL-only, and Pony/Illustrious skew NSFW). One
candidate (Copax TimeLessXL) was **dropped** after the API showed its current version flipped to
`nsfw:true`; Copax Melodies XL was used as the clean substitute.

### What was added
Six checkpoints — `dreamshaper`, `realcartoon`, `nightvision`, `colorful`, `samaritan3d`, `starlight`
(`src/checkpoints.ts`) — chosen to broaden coverage beyond ADR-0014's four (versatile, cartoon-realism,
photoreal, high-saturation, 3D-cartoon, anime). Eleven style LoRAs — ink wash / sumi-e, flat vector,
travel poster, sticker, gouache, charcoal, art deco, risograph, cel shading, woodcut, blueprint
(`src/style-loras.ts`) — filling style gaps the earlier sets didn't cover. Styles now total 33,
checkpoints 10.

### Same machinery, no code change
These are pure catalog data: manifest rows (`install/models.manifest`) with the **Civitai URL as
primary** (and an ungated HF fallback only where one genuinely exists), plus matching `CHECKPOINTS` /
`STYLE_LORAS` entries. They flow through the exact same paths as ADR-0014 — `/checkpoints`, `/styles`,
`/health`, the LoRA-injection and checkpoint-selection code — with **no engine or endpoint change**.
The catalog-integrity tests already assert well-formedness (unique files, `.safetensors`, present
descriptions/triggers), so they cover the new rows.

### Download-time details
The Civitai primaries are gated, so downloading them needs the key (ADR-0013:
`--civitai-token` / `CIVITAI_TOKEN` / `install/secrets.env`). One LoRA's source filename contained
spaces (`Technical Blueprint - XL SDXL V2.0`), which the installer's whitespace-stripping would
mangle — the manifest **dest filename** is space-free (`Technical_Blueprint_XL_SDXL_V2.0.safetensors`)
and `STYLE_LORAS` references that. Two LoRAs are unusually large full-rank trainings (risograph
~1.3 GB, woodcut ~870 MB); their `min-megabytes` floors are set accordingly.

## Consequences
- **A much wider, genuinely popular SFW model set** is selectable by friendly name — the models people
  expect from Civitai, not just the HF-mirrored few.
- **These need the API key to install.** Without it the gated primaries fail; where an HF fallback
  exists it's used, otherwise that entry stays "not installed" (`/checkpoints` reports it) and a style
  degrades to prompt-only — the same graceful path as every other gated row.
- **No new runtime risk.** Additive catalog data only; the render paths, endpoints, and invariants are
  untouched. `grep -rn process.env src/` stays empty; no runtime deps.
- **Civitai versions can drift.** A model can later flip to NSFW or a version can be unpublished. The
  pinned `modelVersionId`s guard against silent content changes; periodic re-verification is prudent.
