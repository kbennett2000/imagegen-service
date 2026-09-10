#!/usr/bin/env bash
# fetch-missing-video-models.sh — download the image-to-video model files /animate uses (Wan 2.2
# TI2V 5B, ADR-0008; LTX-Video 2B, ADR-0015) that AREN'T already present on either drive. The
# video-model counterpart of fetch-missing-checkpoints.sh, with the same defaults (ADR-0017):
# downloads to the second drive by default and searches BOTH drives (built-in + second) RECURSIVELY,
# so a copy already filed into any subfolder counts as present and is not re-downloaded. Each file is
# verified to its exact expected size; a partial/interrupted file resumes (curl -C -).
#
# Usage:
#   scripts/fetch-missing-video-models.sh [--dry-run] [--models-root DIR] [--extra-root DIR]...
#
#   --models-root  ComfyUI models root new files land under (each file goes into its own subdir:
#                  diffusion_models/ vae/ text_encoders/ checkpoints/). Default: the second drive's
#                  comfyui-models (see SECOND_DRIVE_ROOT below). Env: MODELS_ROOT
#   --extra-root   another ComfyUI models root to ALSO search before downloading. Both drives are
#                  searched by default; this adds more. Repeatable. Env: COMFYUI_EXTRA_MODEL_ROOTS (colon-separated)
#   --dry-run      print the plan (download vs present) and exit without downloading
#
# All files are on ungated Hugging Face repos — no token needed. Filenames, sizes, and URLs mirror
# scripts/fetch-wan22-models.ts + fetch-ltxv-models.ts; keep the two in sync if a model is repinned.
set -euo pipefail

DRIVE_MOUNT="/run/media/kb/2TB 02"
SECOND_DRIVE_ROOT="$DRIVE_MOUNT/comfyui-models"
BUILTIN_ROOT="$HOME/comfyui/models"

models_root="${MODELS_ROOT:-$SECOND_DRIVE_ROOT}"
dry_run=0

# Extra ComfyUI models roots to also search, on top of the two defaults (built-in + second drive).
declare -a extra_roots=()
if [[ -n "${COMFYUI_EXTRA_MODEL_ROOTS:-}" ]]; then
  IFS=':' read -r -a extra_roots <<< "$COMFYUI_EXTRA_MODEL_ROOTS"
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)     dry_run=1; shift ;;
    --models-root) models_root="$2"; shift 2 ;;
    --extra-root)  extra_roots+=("$2"); shift 2 ;;
    -h|--help)     sed -n '2,/^set -/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null || { echo "curl is required (sudo apt install curl)" >&2; exit 1; }
command -v find >/dev/null || { echo "find is required" >&2; exit 1; }

# Pinned files, one per line:  name <TAB> subdir <TAB> exact-size-bytes <TAB> url
# (verified against the official Comfy-Org / Lightricks repackages; mirror the TS fetchers).
read -r -d '' MODELS <<'TSV' || true
wan2.2_ti2v_5B_fp16.safetensors	diffusion_models	9999658848	https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors
wan2.2_vae.safetensors	vae	1409400960	https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan2.2_vae.safetensors
umt5_xxl_fp8_e4m3fn_scaled.safetensors	text_encoders	6735906897	https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors
ltx-video-2b-v0.9.5.safetensors	checkpoints	6340729500	https://huggingface.co/Lightricks/LTX-Video/resolve/main/ltx-video-2b-v0.9.5.safetensors
t5xxl_fp8_e4m3fn_scaled.safetensors	text_encoders	5157348688	https://huggingface.co/Comfy-Org/mochi_preview_repackaged/resolve/main/split_files/text_encoders/t5xxl_fp8_e4m3fn_scaled.safetensors
TSV

# Refuse to download onto the second drive when it isn't mounted — otherwise curl would write into an
# empty mount point on the root filesystem (the ADR-0017 removable-mount caveat).
if [[ "$models_root" == "$DRIVE_MOUNT" || "$models_root" == "$DRIVE_MOUNT"/* ]] && ! mountpoint -q "$DRIVE_MOUNT"; then
  echo "The 2TB drive isn't mounted ($DRIVE_MOUNT) — refusing to download to an unmounted path." >&2
  echo "Mount it (open it in Files, or 'udisksctl mount ...'), or pass --models-root to a mounted location." >&2
  exit 1
fi

# Roots searched for an existing copy (recursively, subfolders included): the dest, both default
# drives, and any extra root — deduped, missing dirs dropped at search time.
declare -a search_roots=()
declare -A _seen=()
_cands=("$models_root" "$BUILTIN_ROOT" "$SECOND_DRIVE_ROOT")
for r in "${extra_roots[@]:-}"; do [[ -n "$r" ]] && _cands+=("$r"); done
for r in "${_cands[@]}"; do
  [[ -n "$r" && -z "${_seen[$r]:-}" ]] || continue
  _seen[$r]=1; search_roots+=("$r")
done

echo "Models root: $models_root"
for r in "${search_roots[@]:1}"; do echo "Also search: $r"; done
echo

to_get=0; present=0; failed=0
declare -a plan=()

# Pass 1 — plan. A file counts as PRESENT when a copy at its EXACT byte size is found anywhere under
# any search root (any subfolder). A smaller/partial copy is not a match, so it re-downloads (resume).
while IFS=$'\t' read -r name subdir size url; do
  [[ -z "$name" ]] && continue
  found=""
  for r in "${search_roots[@]}"; do
    [[ -d "$r" ]] || continue
    found="$(find "$r" -type f -name "$name" -size "${size}c" -print -quit 2>/dev/null || true)"
    [[ -n "$found" ]] && break
  done
  if [[ -n "$found" ]]; then
    printf '  [present]  %-42s %s\n' "$name" "$found"
    present=$((present+1)); continue
  fi
  printf '  [download] %-42s -> %s/%s/%s\n' "$name" "$models_root" "$subdir" "$name"
  plan+=("$name"$'\t'"$subdir"$'\t'"$size"$'\t'"$url")
  to_get=$((to_get+1))
done <<< "$MODELS"

echo
echo "Plan: $to_get to download, $present already present."
(( dry_run )) && { echo "(dry run — nothing downloaded)"; exit 0; }
(( to_get == 0 )) && { echo "All image-to-video model files already in place."; exit 0; }

# Pass 2 — download the missing ones to <models_root>/<subdir>/. -L follows redirects, -f fails on an
# HTTP error instead of writing an error page over the model, -C - resumes a partial.
for entry in "${plan[@]}"; do
  IFS=$'\t' read -r name subdir size url <<< "$entry"
  dest="$models_root/$subdir/$name"
  echo; echo "==> $name"
  if ! curl -L -f -C - --create-dirs -o "$dest" "$url"; then
    echo "  FAILED (curl error). Re-run to resume." >&2
    failed=$((failed+1)); continue
  fi
  got="$(stat -c%s "$dest" 2>/dev/null || echo 0)"
  if [[ "$got" != "$size" ]]; then
    echo "  REJECTED: got $got bytes, expected $size — incomplete or wrong file. Re-run to resume." >&2
    failed=$((failed+1)); continue
  fi
  echo "  done: $((got / 1000000)) MB"
done

echo
echo "Finished: $((to_get - failed)) downloaded, $present already present, $failed failed."
echo "Now make ComfyUI re-scan so new files appear (no sudo): scripts/rescan-models.sh"
echo "Then check readiness: curl -s localhost:8189/health | jq '{wan:.wan}'"
(( failed > 0 )) && exit 1 || exit 0
