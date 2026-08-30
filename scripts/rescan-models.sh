#!/usr/bin/env bash
# rescan-models.sh — make ComfyUI re-scan its model folders after you add or move files,
# WITHOUT a root restart. ComfyUI reads its model list once at startup and caches it; a file
# added later (or a second drive that mounted after ComfyUI started — ADR-0017) won't appear
# until it re-scans. This triggers ComfyUI-Manager's in-process reboot (os.execv, runs as your
# user — no sudo), waits for ComfyUI to come back, and prints what newly showed up.
#
# Usage:
#   scripts/rescan-models.sh [--dry-run] [--host URL] [--service URL] [--timeout SECONDS]
#
#   --host      ComfyUI base URL. Default http://localhost:8188. Env: COMFYUI_URL
#   --service   imagegen-service base URL (for the closing /health count). Default
#               http://localhost:8189. Env: IMAGEGEN_URL
#   --timeout   how long to wait for ComfyUI to answer again after reboot. Default 180.
#   --dry-run   show the current checkpoint count and exit without rebooting.
#
# If ComfyUI-Manager isn't installed or its security level blocks the reboot route, this prints
# the one-line sudo fallback (systemctl restart comfyui.service) instead of failing silently.
set -euo pipefail

host="${COMFYUI_URL:-http://localhost:8188}"
service="${IMAGEGEN_URL:-http://localhost:8189}"
timeout=180
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)  dry_run=1; shift ;;
    --host)     host="$2"; shift 2 ;;
    --service)  service="$2"; shift 2 ;;
    --timeout)  timeout="$2"; shift 2 ;;
    -h|--help)  sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v jq   >/dev/null || { echo "jq is required (sudo apt install jq)"   >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required (sudo apt install curl)" >&2; exit 1; }

host="${host%/}"; service="${service%/}"

# List ComfyUI's current checkpoint enum, one per line (empty if ComfyUI is unreachable).
list_checkpoints() {
  curl -s -m 10 "$host/object_info/CheckpointLoaderSimple" \
    | jq -r '.CheckpointLoaderSimple.input.required.ckpt_name[0][]?' 2>/dev/null || true
}

sudo_fallback() {
  echo >&2
  echo "Could not trigger an in-process rescan ($1)." >&2
  echo "Restart ComfyUI the manual way (needs your password):" >&2
  echo "    sudo systemctl restart comfyui.service" >&2
  echo "then re-run this script (or check: curl -s $service/health | jq .checkpoints)." >&2
}

before="$(list_checkpoints)"
if [[ -z "$before" ]]; then
  echo "ComfyUI at $host isn't answering (or lists no checkpoints)." >&2
  echo "Is it running?  systemctl status comfyui.service" >&2
  exit 1
fi
before_n="$(printf '%s\n' "$before" | grep -c . || true)"
echo "ComfyUI now lists $before_n checkpoint(s)."

if (( dry_run )); then
  echo "(dry run — not rebooting)"
  exit 0
fi

# Trigger ComfyUI-Manager's reboot. The JSON content-type clears its cross-origin form guard.
# os.execv replaces the process mid-response, so a dropped connection (code 000) is success;
# only a real HTTP status (403 blocked, 404 no route) means the reboot did NOT happen.
echo "Asking ComfyUI to re-scan (ComfyUI-Manager reboot; no sudo)…"
code="$(curl -s -o /dev/null -w '%{http_code}' -m 8 \
  -X POST -H 'Content-Type: application/json' "$host/manager/reboot" 2>/dev/null || true)"
case "$code" in
  403) sudo_fallback "ComfyUI-Manager blocked it: security_level too high"; exit 1 ;;
  404) sudo_fallback "no /manager/reboot route — ComfyUI-Manager not installed"; exit 1 ;;
  200|000|"") : ;;  # 000 = connection dropped as it re-execed = expected
  *)   sudo_fallback "unexpected HTTP $code from /manager/reboot"; exit 1 ;;
esac

# Wait for ComfyUI to answer again. --retry-connrefused rides out the down window without sleep.
echo "Waiting up to ${timeout}s for ComfyUI to come back…"
retries=$(( timeout / 3 )); (( retries < 1 )) && retries=1
if ! curl -s -o /dev/null --retry "$retries" --retry-delay 3 --retry-connrefused -m 5 \
        "$host/object_info/CheckpointLoaderSimple"; then
  echo "ComfyUI did not answer within ${timeout}s. Check: systemctl status comfyui.service" >&2
  exit 1
fi

after="$(list_checkpoints)"
after_n="$(printf '%s\n' "$after" | grep -c . || true)"

# New = present after but not before.
new="$(comm -13 <(printf '%s\n' "$before" | sort) <(printf '%s\n' "$after" | sort) || true)"

echo
echo "Rescan complete: $before_n → $after_n checkpoint(s)."
if [[ -n "$new" ]]; then
  echo "Newly visible:"
  printf '  + %s\n' $new
else
  echo "(no new checkpoints — everything on disk was already scanned)"
fi
echo
echo "Service view:  curl -s $service/health | jq .checkpoints"
