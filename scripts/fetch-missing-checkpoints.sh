#!/usr/bin/env bash
# fetch-missing-checkpoints.sh — run a CivitAI model search and download every returned checkpoint
# that ISN'T already present on EITHER drive: the built-in ComfyUI models dir and the second drive
# (ADR-0017), plus any extra model root you pass. Both are searched RECURSIVELY, so a copy you've
# filed into a subfolder (e.g. s/ or ns/) still counts as present and is not re-downloaded.
# Idempotent: a full-size copy found anywhere in those trees is skipped; a top-level partial/
# interrupted file resumes (curl -C -).
# A download that comes back too small (a login/error page, not a model) is rejected and removed.
#
# Usage:
#   scripts/fetch-missing-checkpoints.sh [--dry-run] [--dest DIR] [--extra-root DIR]... [--url URL] [--token TOK] [--min-mb N]
#
# Defaults mirror the SDXL-checkpoint search in docs/adding-models.md. Config is flags/env only:
#   --url         full CivitAI /api/v1/models query URL (URL-encode spaces as %20). Env: CIVITAI_API_URL
#   --dest        ComfyUI checkpoints dir new files land in. Default: the second drive's
#                 checkpoints/ (see SECOND_DRIVE_ROOT below). Env: CHECKPOINTS_DIR
#   --extra-root  another ComfyUI models root to ALSO search (its checkpoints/ subdir) before
#                 downloading. Both drives are already searched by default; this adds more.
#                 Repeatable. Env: COMFYUI_EXTRA_MODEL_ROOTS (colon-separated)
#   --token       CivitAI token (Bearer, civitai.com only). Default: $CIVITAI_TOKEN, else install/secrets.env
#   --min-mb      reject a download smaller than this many MB (catches HTML/login error pages). Default 1000
#   --dry-run     print the plan (download vs skip) and exit without downloading
set -euo pipefail

DEFAULT_URL='https://civitai.com/api/v1/models?types=Checkpoint&baseModels=SDXL%201.0&sort=Most%20Downloaded&nsfw=false&limit=10'

# The two ComfyUI model roots this deployment uses (ADR-0017): the built-in dir and the second drive.
# Both are searched for an existing copy; new checkpoints download to the second drive by default.
# Override --dest / CHECKPOINTS_DIR for a different destination.
BUILTIN_ROOT="$HOME/comfyui/models"
SECOND_DRIVE_ROOT="/run/media/kb/2TB 02/comfyui-models"

api_url="${CIVITAI_API_URL:-$DEFAULT_URL}"
dest_dir="${CHECKPOINTS_DIR:-$SECOND_DRIVE_ROOT/checkpoints}"
token_override=""
min_mb="${MIN_MB:-1000}"
dry_run=0

# Extra ComfyUI models roots to also search before downloading, on top of the two defaults above.
# Colon-separated in the env, repeatable via --extra-root.
declare -a extra_roots=()
if [[ -n "${COMFYUI_EXTRA_MODEL_ROOTS:-}" ]]; then
  IFS=':' read -r -a extra_roots <<< "$COMFYUI_EXTRA_MODEL_ROOTS"
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)    dry_run=1; shift ;;
    --dest)       dest_dir="$2"; shift 2 ;;
    --extra-root) extra_roots+=("$2"); shift 2 ;;
    --url)        api_url="$2"; shift 2 ;;
    --token)      token_override="$2"; shift 2 ;;
    --min-mb)     min_mb="$2"; shift 2 ;;
    -h|--help)    sed -n '2,/^set -/p' "$0" | sed '$d'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v jq   >/dev/null || { echo "jq is required (sudo apt install jq)"   >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required (sudo apt install curl)" >&2; exit 1; }

# Resolve the token: --token > $CIVITAI_TOKEN > install/secrets.env. Never printed.
token="${token_override:-${CIVITAI_TOKEN:-}}"
if [[ -z "$token" && -f "$repo_root/install/secrets.env" ]]; then
  token="$(grep -oP '(?<=^CIVITAI_TOKEN=).*' "$repo_root/install/secrets.env" 2>/dev/null || true)"
fi

# If the destination is on the removable second drive, make sure it's actually mounted — otherwise
# mkdir/curl would write into an empty mount point on the root filesystem (the ADR-0017 caveat).
drive_mount="/run/media/kb/2TB 02"
if [[ "$dest_dir" == "$drive_mount"/* ]] && ! mountpoint -q "$drive_mount"; then
  echo "The 2TB drive isn't mounted ($drive_mount) — refusing to download to an unmounted path." >&2
  echo "Mount it (open it in Files, or 'udisksctl mount ...'), or pass --dest to a mounted location." >&2
  exit 1
fi

mkdir -p "$dest_dir"

# Directories the "already installed?" check searches (recursively, subfolders included): the dest,
# plus both default roots' checkpoints/ subdir, plus any extra root — deduped, missing dirs dropped
# at search time. So a full-size copy present on EITHER drive, in any subfolder, blocks a download.
declare -a search_dirs=()
declare -A _seen=()
_candidates=("$dest_dir" "$BUILTIN_ROOT/checkpoints" "$SECOND_DRIVE_ROOT/checkpoints")
for root in "${extra_roots[@]:-}"; do [[ -n "$root" ]] && _candidates+=("$root/checkpoints"); done
for d in "${_candidates[@]}"; do
  [[ -n "$d" && -z "${_seen[$d]:-}" ]] || continue
  _seen[$d]=1; search_dirs+=("$d")
done

echo "Search:  $api_url"
echo "Dest:    $dest_dir"
for d in "${search_dirs[@]:1}"; do echo "Also:    $d"; done
echo "Token:   $([[ -n "$token" ]] && echo present || echo 'MISSING (Civitai-gated files will fail — set CIVITAI_TOKEN or use an HF mirror)')"
echo

# For each returned model, pick the best file: the primary SafeTensor Model, else any SafeTensor
# Model, else the first file. Emit one TSV row: <filename>\t<sizeMB>\t<downloadUrl>.
rows="$(curl -s --fail --max-time 60 "$api_url" | jq -r '
  .items[]
  | .modelVersions[0] as $v
  | ( [ $v.files[] | select(.type=="Model" and .metadata.format=="SafeTensor" and .primary==true) ]
      + [ $v.files[] | select(.type=="Model" and .metadata.format=="SafeTensor") ]
      + [ $v.files[] ] )[0] as $f
  | select($f != null and $f.name != null and $f.downloadUrl != null)
  | [ $f.name, (($f.sizeKB // 0)/1024|floor), $f.downloadUrl ] | @tsv
')" || { echo "Query failed (check the URL / network)." >&2; exit 1; }

[[ -z "$rows" ]] && { echo "No models returned by the query."; exit 0; }

to_get=0; skipped=0; failed=0
declare -a plan=()

# Pass 1 — build and print the plan (download vs already-installed).
# "Already installed" is checked RECURSIVELY across every search dir: a full-size copy of the file
# found anywhere on either drive — including subfolders you've organized files into (s/, ns/) —
# counts as present and is skipped. New downloads land flat at the top of dest_dir; filing them into
# a subfolder afterwards stays manual (and won't trigger a re-download next run).
while IFS=$'\t' read -r name size_mb url; do
  [[ -z "$name" ]] && continue
  found=""
  for d in "${search_dirs[@]}"; do
    [[ -d "$d" ]] || continue
    found="$(find "$d" -type f -name "$name" -size +"${min_mb}"M -print -quit 2>/dev/null || true)"
    [[ -n "$found" ]] && break
  done
  if [[ -n "$found" ]]; then
    printf '  [skip]     %-55s already installed (%s)\n' "$name" "$found"
    skipped=$((skipped+1)); continue
  fi
  printf '  [download] %-55s %s MB\n' "$name" "$size_mb"
  plan+=("$name"$'\t'"$url")
  to_get=$((to_get+1))
done <<< "$rows"

echo
echo "Plan: $to_get to download, $skipped already installed."
(( dry_run )) && { echo "(dry run — nothing downloaded)"; exit 0; }
(( to_get == 0 )) && { echo "Nothing to do."; exit 0; }

# Pass 2 — download the missing ones.
for entry in "${plan[@]}"; do
  IFS=$'\t' read -r name url <<< "$entry"
  dest="$dest_dir/$name"
  echo; echo "==> $name"
  auth=()
  [[ -n "$token" && "$url" == https://civitai.com/* ]] && auth=(-H "Authorization: Bearer $token")
  if ! curl -L -f -C - "${auth[@]}" --create-dirs -o "$dest" "$url"; then
    echo "  FAILED (curl error). Re-run to resume." >&2
    failed=$((failed+1)); continue
  fi
  got_mb=$(( $(stat -c%s "$dest" 2>/dev/null || echo 0) / 1048576 ))
  if (( got_mb < min_mb )); then
    echo "  REJECTED: only ${got_mb} MB (< ${min_mb} MB) — a login/error page, not a model. Removing." >&2
    echo "  If this repeats, the model is gated: set CIVITAI_TOKEN in install/secrets.env or use an HF mirror." >&2
    rm -f "$dest"; failed=$((failed+1)); continue
  fi
  echo "  done: ${got_mb} MB"
done

echo
echo "Finished: $((to_get-failed)) downloaded, $skipped skipped, $failed failed."
echo "Now make ComfyUI re-scan so the new files appear (no sudo): scripts/rescan-models.sh"
echo "Then check the service: curl -s localhost:8189/health | jq .checkpoints"
(( failed > 0 )) && exit 1 || exit 0
