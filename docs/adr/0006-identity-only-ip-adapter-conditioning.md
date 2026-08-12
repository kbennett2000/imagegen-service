# ADR-0006: Identity-only IP-Adapter conditioning

- **Status:** Accepted
- **Date:** 2026-08-12
- **Relates to:** [ADR-0001](0001-imagegen-service-spec.md) (service spec). Caller-side companion:
  scriptorium ADR-0028.

## Context

`applyIPAdapter` injected the reference over the **entire** denoising schedule
(`start_at: 0.0`, `end_at: 1.0`, `weight_type: "linear"`) and fed
`ip-adapter-plus-face_sdxl_vit-h` the caller's reference image **uncropped**.

Both are wrong for a face adapter, and the caller found out the expensive way. A downstream book
conditioned 348 illustrations on character portraits; one portrait happened to render as two men in
uniform against red curtains, and **84 plates came back as near-copies of it** — same two figures,
same uniforms, same curtains, same table — regardless of what their prompts asked for. Prompts that
explicitly described a woman in a black silk dress produced a second man in uniform.

The mechanism is not subtle once stated:

1. **`start_at: 0.0`** injects identity during the earliest, highest-noise steps — exactly the steps
   that decide global layout and *how many figures are in the frame*. The adapter was therefore
   dictating composition, not just likeness.
2. **`plus-face` expects a face crop.** Given a full bust it encodes the clothing, the background
   and the framing along with the face, and transfers all of it.

The pre-existing mitigation was a lowered `weight` (0.55), with the code comment *"a bust portrait
reference at higher weight collapses every scene into a bust"* — the same symptom, correctly
observed, treated with the wrong dial. Lowering weight trades identity strength against composition
control and buys neither.

## Decision

- **`start_at` defaults to `0.30`.** The early steps belong to the text prompt alone; identity lands
  afterwards, which is all a face adapter is for.
- **Head-crop the reference** via `PrepImageForClipVision` (`crop_position: "top"`,
  `interpolation: "LANCZOS"`) as graph node `25`, between `LoadImage` and `IPAdapterAdvanced`.
- **`weight_type: "ease in-out"`**, so identity blends in rather than snapping on at `start_at`.
- **Default `weight` 0.55 → 0.5**, now that weight is no longer doing composition's job.
- **New optional request field `referenceStart`**, validated to `[0, 0.5]` (past half the schedule
  there is too little signal left for a likeness to form), alongside the existing
  `referenceStrength`. Callers raise it for a crowded frame, lower it for a solo subject.

Per ADR-0001 this is file-config/request-driven only — **no environment variables**.

## Consequences

- Conditioned renders change. This is intended and is the point of the ADR; it is a behaviour
  change for every caller passing `references`, not an opt-in.
- **Degrades gracefully.** A host without `PrepImageForClipVision` (an older IPAdapter pack) is
  detected via `/object_info` and conditions on the raw reference; node `25` is simply absent and
  the schedule offset still applies. Unreferenced renders are untouched.
- `nodeAvailable()` generalises the existing `ipAdapterAvailable()` probe for optional graph parts.
- The default is a compromise across callers. A caller that knows its frame holds one subject can
  push `referenceStart` down for a stronger likeness; scriptorium does the reverse for multi-figure
  plates.

## Not decided here

- **Attention masking / regional conditioning** for more than one identity in a frame. `references`
  still accepts up to 4 images but only the first is used, and it applies globally. Multi-identity
  is a larger change and belongs to whichever caller can supply the regions.
