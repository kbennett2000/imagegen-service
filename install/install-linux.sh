#!/usr/bin/env bash
#
# install-linux.sh — full-stack auto-installer for imagegen-service on Ubuntu Linux.
#
# Takes a machine with a WORKING NVIDIA driver from nothing to a running service:
#   ComfyUI (isolated uv Python 3.11 venv, torch cu128) + ComfyUI-Manager, SDXL base/refiner/VAE,
#   the 12 style LoRAs, this repo's Node deps, config.json, and BOTH auto-start systemd services.
#
# GUIDING PRINCIPLE: automate everything EXCEPT the NVIDIA driver. We DETECT the driver/CUDA and,
# if it is missing or too old, STOP with a plain-language message + the official link — we never
# install or change the driver (that can break your display).
#
# Idempotent: safe to re-run. Every step checks what is already there and skips it.
#
# Usage:
#   bash install/install-linux.sh                       # full install (idempotent)
#   bash install/install-linux.sh --check               # preflight ONLY: detect + report, change nothing
#   bash install/install-linux.sh --civitai-token KEY   # Civitai API key for login-gated downloads
#   bash install/install-linux.sh --help
#
# The Civitai API key (only needed for login-gated model downloads) can also come from a
# CIVITAI_TOKEN env var or an install/secrets.env file — see install/secrets.env.example.
# Precedence: --civitai-token flag > CIVITAI_TOKEN env > install/secrets.env file.
#
set -uo pipefail

# ------------------------------------------------------------------------------------------------
# Paths & constants
# ------------------------------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
MANIFEST="$SCRIPT_DIR/models.manifest"
COMFYUI_DIR="${HOME}/comfyui"
COMFYUI_REPO="https://github.com/comfyanonymous/ComfyUI.git"
MANAGER_REPO="https://github.com/ltdrdata/ComfyUI-Manager.git"
TORCH_INDEX="https://download.pytorch.org/whl/cu128"
PY_VERSION="3.11"
MIN_CUDA_MAJORMINOR=1208   # cu128 wheels need CUDA capability >= 12.8
VRAM_WARN_MIB=11000        # warn (don't block) below ~11 GB
COMFYUI_PORT=8188
SERVICE_PORT=8189
DRIVER_LINK="https://www.nvidia.com/Download/index.aspx"

CHECK_ONLY=0
SKIPPED_MODELS=()          # dest filenames that could not be fetched (styles that degrade)

# Civitai API token for gated model downloads (see install/secrets.env.example). Resolved after arg
# parsing, precedence: --civitai-token flag > $CIVITAI_TOKEN env > install/secrets.env file. Capture
# any inherited env value now, BEFORE we take over the variable name for our own resolved token.
SECRETS_FILE="$SCRIPT_DIR/secrets.env"
CIVITAI_TOKEN_FROM_ENV="${CIVITAI_TOKEN:-}"
CIVITAI_TOKEN=""

# ------------------------------------------------------------------------------------------------
# Output helpers (plain language, no jargon in the happy path)
# ------------------------------------------------------------------------------------------------
c_reset=""; c_red=""; c_grn=""; c_ylw=""; c_bld=""
if [ -t 1 ]; then c_reset=$'\033[0m'; c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_bld=$'\033[1m'; fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$c_bld" "$*" "$c_reset"; }
ok()   { printf '%s  ok:%s %s\n' "$c_grn" "$c_reset" "$*"; }
warn() { printf '%s  warning:%s %s\n' "$c_ylw" "$c_reset" "$*"; }
skip() { printf '  skip: %s\n' "$*"; }

# Fatal stop: say which step failed and how to re-run, then exit non-zero.
die() {
  printf '\n%serror:%s %s\n' "$c_red" "$c_reset" "$1"
  [ $# -ge 2 ] && printf '  %s\n' "$2"
  printf '\nFix the problem above, then run this installer again:\n  bash %s\n' "$0"
  exit 1
}

# ------------------------------------------------------------------------------------------------
# Arg parsing
# ------------------------------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --check|--dry-run) CHECK_ONLY=1 ;;
    --civitai-token)
      shift; [ $# -gt 0 ] || die "--civitai-token requires a value (your Civitai API key)."
      CIVITAI_TOKEN="$1" ;;
    --civitai-token=*) CIVITAI_TOKEN="${1#*=}" ;;
    -h|--help)
      sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) die "unknown option: $1" "Run with --help to see valid options." ;;
  esac
  shift
done

# Resolve the Civitai token: flag (set above) > inherited env > secrets file. Only the file is
# parsed here; the flag/env are already captured. The token is used ONLY for civitai.com downloads.
resolve_civitai_token() {
  [ -n "$CIVITAI_TOKEN" ] && return 0
  if [ -n "$CIVITAI_TOKEN_FROM_ENV" ]; then CIVITAI_TOKEN="$CIVITAI_TOKEN_FROM_ENV"; return 0; fi
  [ -f "$SECRETS_FILE" ] || return 0
  local line val
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      \#*|'') continue ;;
      CIVITAI_TOKEN=*)
        val="${line#CIVITAI_TOKEN=}"
        val="${val%$'\r'}"                          # strip a trailing CR (CRLF files)
        val="${val#[\"\']}"; val="${val%[\"\']}"    # strip one pair of surrounding quotes
        CIVITAI_TOKEN="$val" ;;
    esac
  done < "$SECRETS_FILE"
}
resolve_civitai_token

# ================================================================================================
# 1. PREFLIGHT / DRIVER GATE
# ================================================================================================
preflight() {
  step "Step 1/5 — Checking your system"

  # --- OS / platform ---
  if [ "$(uname -s)" != "Linux" ]; then
    die "This installer is for Linux. On Windows use install/install-windows.ps1 instead."
  fi
  local os_name="Linux"
  if [ -r /etc/os-release ]; then
    os_name="$(. /etc/os-release; echo "${PRETTY_NAME:-Linux}")"
    if ! grep -qiE 'ubuntu|debian' /etc/os-release; then
      warn "Detected '$os_name'. This installer is tuned for Ubuntu; it may work on other distros."
    fi
  fi
  ok "Operating system: $os_name"

  # --- NVIDIA driver gate (the one thing we never auto-install) ---
  if ! command -v nvidia-smi >/dev/null 2>&1; then
    say ""
    say "  No NVIDIA driver was found (nvidia-smi is not installed)."
    say "  imagegen-service needs an NVIDIA GPU with a recent driver."
    say ""
    say "  1. Install the official NVIDIA driver:  $DRIVER_LINK"
    say "  2. Reboot your computer."
    say "  3. Run this installer again."
    die "NVIDIA driver not detected."
  fi

  local gpu_line gpu_name vram_mib driver_ver cuda_cap cuda_major cuda_minor cuda_mm
  gpu_line="$(nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>/dev/null | head -1)"
  gpu_name="$(echo "$gpu_line"  | awk -F', *' '{print $1}')"
  vram_mib="$(echo "$gpu_line"  | awk -F', *' '{print $2}')"
  driver_ver="$(echo "$gpu_line"| awk -F', *' '{print $3}')"

  # CUDA capability is reported in the nvidia-smi banner as "CUDA Version: X.Y".
  cuda_cap="$(nvidia-smi 2>/dev/null | grep -oE 'CUDA Version: [0-9]+\.[0-9]+' | grep -oE '[0-9]+\.[0-9]+' | head -1)"
  if [ -z "$cuda_cap" ]; then
    die "Could not read the CUDA version from your NVIDIA driver." \
        "Reinstall/upgrade the official driver ($DRIVER_LINK), reboot, and re-run."
  fi
  cuda_major="${cuda_cap%%.*}"; cuda_minor="${cuda_cap##*.}"
  cuda_mm=$(( cuda_major * 100 + cuda_minor ))

  ok "GPU: ${gpu_name:-unknown}  (${vram_mib:-?} MiB VRAM)"
  ok "NVIDIA driver: ${driver_ver:-unknown}  (CUDA capability ${cuda_cap})"

  if [ "$cuda_mm" -lt "$MIN_CUDA_MAJORMINOR" ]; then
    say ""
    say "  Your NVIDIA driver supports CUDA ${cuda_cap}, but SDXL needs CUDA 12.8 or newer"
    say "  (the cu128 PyTorch build). Your driver is too old."
    say ""
    say "  1. Update the official NVIDIA driver:  $DRIVER_LINK"
    say "  2. Reboot your computer."
    say "  3. Run this installer again."
    die "NVIDIA driver too old for CUDA 12.8 (cu128)."
  fi

  if [ -n "$vram_mib" ] && [ "$vram_mib" -lt "$VRAM_WARN_MIB" ] 2>/dev/null; then
    warn "Your GPU has ${vram_mib} MiB VRAM. SDXL + a LoRA is happiest with ~11 GB+; it may run"
    warn "slowly or run out of memory on large images. Continuing anyway."
  fi

  # --- Disk space (rough: full stack ~25-30 GB of models + env) ---
  local avail_gb
  avail_gb="$(df -Pk "$HOME" | awk 'NR==2{printf "%d", $4/1024/1024}')"
  if [ -n "$avail_gb" ] && [ "$avail_gb" -lt 30 ]; then
    warn "Only ~${avail_gb} GB free under $HOME. The full stack needs ~30 GB. Free some space."
  else
    ok "Disk space: ~${avail_gb} GB free under $HOME"
  fi

  # --- Report what's already installed (informational; drives idempotent skips later) ---
  say ""
  say "  Already present on this machine:"
  report_present "ComfyUI checkout"      "[ -f '$COMFYUI_DIR/main.py' ]"
  report_present "ComfyUI Python venv"   "[ -x '$COMFYUI_DIR/.venv/bin/python' ]"
  report_present "PyTorch (cu128)"       "comfy_torch_ok"
  report_present "ComfyUI-Manager"       "[ -d '$COMFYUI_DIR/custom_nodes/ComfyUI-Manager' ]"
  report_present "Node.js"               "command -v node >/dev/null 2>&1"
  report_present "Service deps (node_modules)" "[ -d '$REPO_DIR/node_modules' ]"
  report_present "config.json"           "[ -f '$REPO_DIR/config.json' ]"
  report_present "comfyui.service"       "systemctl_enabled comfyui.service"
  report_present "imagegen-service.service" "systemctl_enabled imagegen-service.service"
  report_models_present
}

# report_present <label> <test-expr-or-func>
report_present() {
  if eval "$2" >/dev/null 2>&1; then printf '    [x] %s\n' "$1"; else printf '    [ ] %s\n' "$1"; fi
}
report_models_present() {
  local present=0 total=0 line subdir fn _p _f _m
  [ -f "$MANIFEST" ] || return 0
  while IFS='|' read -r subdir fn _p _f _m; do
    case "$subdir" in ''|\#*) continue ;; esac
    total=$((total+1))
    [ -f "$COMFYUI_DIR/models/$subdir/$fn" ] && present=$((present+1))
  done < "$MANIFEST"
  printf '    [%s] Model files: %d / %d present\n' "$([ "$present" = "$total" ] && echo x || echo ' ')" "$present" "$total"
}
systemctl_enabled() { systemctl is-enabled "$1" >/dev/null 2>&1; }
systemctl_active()  { systemctl is-active  "$1" >/dev/null 2>&1; }
comfy_torch_ok() { "$COMFYUI_DIR/.venv/bin/python" -c 'import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)' >/dev/null 2>&1; }

# ================================================================================================
# 2. COMFYUI (isolated uv env + torch cu128 + ComfyUI-Manager)
# ================================================================================================
ensure_uv() {
  if command -v uv >/dev/null 2>&1; then return 0; fi
  if [ -x "$HOME/.local/bin/uv" ]; then export PATH="$HOME/.local/bin:$PATH"; return 0; fi
  say "  Installing uv (fast Python env manager)…"
  curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1 || die "Failed to install uv."
  export PATH="$HOME/.local/bin:$PATH"
  command -v uv >/dev/null 2>&1 || die "uv installed but not on PATH."
}

install_comfyui() {
  step "Step 2/5 — Installing ComfyUI"
  ensure_uv

  # Clone
  if [ -f "$COMFYUI_DIR/main.py" ]; then
    skip "ComfyUI already checked out at $COMFYUI_DIR"
  else
    say "  Downloading ComfyUI to $COMFYUI_DIR …"
    git clone --depth 1 "$COMFYUI_REPO" "$COMFYUI_DIR" || die "Failed to clone ComfyUI."
    ok "ComfyUI downloaded"
  fi

  # Isolated venv (Python 3.11)
  if [ -x "$COMFYUI_DIR/.venv/bin/python" ]; then
    skip "Python venv already exists"
  else
    say "  Creating an isolated Python $PY_VERSION environment …"
    uv venv --python "$PY_VERSION" "$COMFYUI_DIR/.venv" || die "Failed to create the Python venv."
    ok "Python $PY_VERSION environment ready"
  fi
  local PY="$COMFYUI_DIR/.venv/bin/python"

  # PyTorch cu128
  if comfy_torch_ok; then
    skip "PyTorch with CUDA already working"
  else
    say "  Installing PyTorch (CUDA 12.8 build) — this is a large download …"
    uv pip install --python "$PY" torch torchvision --index-url "$TORCH_INDEX" \
      || die "Failed to install PyTorch (cu128)."
    comfy_torch_ok || die "PyTorch installed but CUDA is not available to it." \
      "Confirm the NVIDIA driver is loaded (nvidia-smi) and re-run."
    ok "PyTorch (cu128) installed and sees the GPU"
  fi

  # ComfyUI's own requirements (sentinel-guarded so re-runs are true no-ops)
  local deps_sentinel="$COMFYUI_DIR/.venv/.imagegen_deps_ok"
  if [ -f "$deps_sentinel" ]; then
    skip "ComfyUI dependencies already installed"
  else
    say "  Installing ComfyUI dependencies …"
    uv pip install --python "$PY" -r "$COMFYUI_DIR/requirements.txt" >/dev/null \
      || die "Failed to install ComfyUI requirements."
    touch "$deps_sentinel"
    ok "ComfyUI dependencies installed"
  fi

  # ComfyUI-Manager
  if [ -d "$COMFYUI_DIR/custom_nodes/ComfyUI-Manager" ]; then
    skip "ComfyUI-Manager already installed"
  else
    say "  Installing ComfyUI-Manager …"
    git clone --depth 1 "$MANAGER_REPO" "$COMFYUI_DIR/custom_nodes/ComfyUI-Manager" \
      || warn "Could not install ComfyUI-Manager (non-fatal); continuing."
    if [ -f "$COMFYUI_DIR/custom_nodes/ComfyUI-Manager/requirements.txt" ]; then
      uv pip install --python "$PY" -r "$COMFYUI_DIR/custom_nodes/ComfyUI-Manager/requirements.txt" >/dev/null 2>&1 || true
    fi
    ok "ComfyUI-Manager installed"
  fi
}

# ================================================================================================
# 3. MODELS (download-with-mirror-fallback + real-safetensors verification)
# ================================================================================================

# verify_safetensors <file> <min_megabytes> -> 0 if the file is a real .safetensors of sane size.
# A .safetensors file starts with an 8-byte little-endian header length N, then N bytes of JSON
# beginning with '{'. HTML/JSON error pages fail size and/or this header check.
verify_safetensors() {
  local f="$1" minmb="$2" size hdr b0 b1 b2 b3 b4 b5 b6 b7 n c9
  [ -f "$f" ] || return 1
  size="$(stat -c%s "$f" 2>/dev/null || echo 0)"
  [ "$size" -ge $(( minmb * 1024 * 1024 )) ] || return 1
  # first 8 bytes -> little-endian uint64 header length
  read -r b0 b1 b2 b3 b4 b5 b6 b7 <<<"$(dd if="$f" bs=1 count=8 2>/dev/null | od -An -tu1 | tr -s ' ')"
  [ -n "$b7" ] || return 1
  n=$(( b0 + b1*256 + b2*65536 + b3*16777216 + b4*4294967296 + b5*1099511627776 + b6*281474976710656 + b7*72057594037927936 ))
  [ "$n" -gt 0 ] && [ "$n" -lt "$size" ] || return 1
  # byte at offset 8 must open the JSON header
  c9="$(dd if="$f" bs=1 skip=8 count=1 2>/dev/null)"
  [ "$c9" = "{" ] || return 1
  return 0
}

# fetch <url> <dest-tmp> -> 0 on a successful HTTP download (follows redirects). For civitai.com
# URLs a "Authorization: Bearer <token>" header is added when a token is configured — never for any
# other host, so the token cannot leak to Hugging Face or a mirror.
fetch() {
  local url="$1" tmp="$2"
  local auth=()
  case "$url" in
    https://civitai.com/*|http://civitai.com/*|https://*.civitai.com/*|http://*.civitai.com/*)
      [ -n "$CIVITAI_TOKEN" ] && auth=(-H "Authorization: Bearer $CIVITAI_TOKEN") ;;
  esac
  if command -v curl >/dev/null 2>&1; then
    curl -fL --retry 3 --retry-delay 2 --connect-timeout 30 "${auth[@]}" -o "$tmp" "$url"
  else
    local wauth=()
    [ "${#auth[@]}" -gt 0 ] && wauth=(--header="Authorization: Bearer $CIVITAI_TOKEN")
    wget -q --tries=3 "${wauth[@]}" -O "$tmp" "$url"
  fi
}

# download_verify <subdir> <filename> <primary> <fallback> <minmb>
download_verify() {
  local subdir="$1" fn="$2" primary="$3" fallback="$4" minmb="$5"
  local dir="$COMFYUI_DIR/models/$subdir" dest tmp url
  mkdir -p "$dir"; dest="$dir/$fn"

  if verify_safetensors "$dest" "$minmb"; then skip "$fn (already present)"; return 0; fi

  tmp="$dest.part"
  for url in "$primary" "$fallback"; do
    [ "$url" = "-" ] || [ -z "$url" ] && continue
    say "  Downloading $fn …"
    rm -f "$tmp"
    if fetch "$url" "$tmp" && verify_safetensors "$tmp" "$minmb"; then
      mv -f "$tmp" "$dest"; ok "$fn"
      return 0
    fi
    warn "Source failed or was not a valid model file; trying the next source for $fn"
  done
  rm -f "$tmp"
  warn "Could not fetch $fn from any source — the matching style will fall back to prompt-only."
  SKIPPED_MODELS+=("$fn")
  return 1
}

install_models() {
  step "Step 3/5 — Downloading models (SDXL + LoRAs)"
  [ -f "$MANIFEST" ] || die "Model manifest not found at $MANIFEST"
  [ -n "$CIVITAI_TOKEN" ] && ok "Using a Civitai API token for login-gated downloads"
  local subdir fn primary fallback minmb
  while IFS='|' read -r subdir fn primary fallback minmb; do
    case "$subdir" in ''|\#*) continue ;; esac
    subdir="$(echo "$subdir" | tr -d '[:space:]')"; fn="$(echo "$fn" | tr -d '[:space:]')"
    primary="$(echo "$primary" | tr -d '[:space:]')"; fallback="$(echo "$fallback" | tr -d '[:space:]')"
    minmb="$(echo "$minmb" | tr -d '[:space:]')"
    download_verify "$subdir" "$fn" "$primary" "$fallback" "$minmb"
  done < "$MANIFEST"
  if [ "${#SKIPPED_MODELS[@]}" -gt 0 ]; then
    warn "${#SKIPPED_MODELS[@]} model(s) could not be downloaded: ${SKIPPED_MODELS[*]}"
  else
    ok "All model files present"
  fi
}

# ================================================================================================
# 4. THE SERVICE (Node deps + config.json + systemd units)
# ================================================================================================
ensure_node() {
  if command -v node >/dev/null 2>&1; then return 0; fi
  # Install nvm + an LTS node if node is absent (matches how this repo runs node).
  say "  Node.js not found — installing it via nvm …"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash >/dev/null 2>&1 \
      || die "Failed to install nvm (needed to install Node.js)."
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install --lts >/dev/null 2>&1 || die "Failed to install Node.js via nvm."
  command -v node >/dev/null 2>&1 || die "Node.js installed but not on PATH."
}

install_service() {
  step "Step 4/5 — Setting up the imagegen-service"
  ensure_node
  local NODE_BIN NODE_DIR
  NODE_BIN="$(command -v node)"; NODE_DIR="$(dirname "$NODE_BIN")"
  ok "Node.js: $NODE_BIN"

  # Dependencies
  if [ -d "$REPO_DIR/node_modules" ]; then
    skip "Service dependencies already installed"
  else
    say "  Installing service dependencies …"
    ( cd "$REPO_DIR" && npm install >/dev/null 2>&1 ) || die "npm install failed in $REPO_DIR"
    ok "Service dependencies installed"
  fi

  # config.json (config-file only; NEVER env vars)
  if [ -f "$REPO_DIR/config.json" ]; then
    skip "config.json already present (left untouched)"
  else
    cp "$REPO_DIR/config.example.json" "$REPO_DIR/config.json" || die "Could not write config.json"
    ok "Wrote config.json (ComfyUI at localhost:$COMFYUI_PORT, service on $SERVICE_PORT)"
  fi

  install_systemd_units "$NODE_BIN" "$NODE_DIR"
}

# Determine how (if at all) we can run privileged commands.
detect_sudo() {
  if [ "$(id -u)" = "0" ]; then echo ""; return; fi
  if sudo -n true >/dev/null 2>&1; then echo "sudo"; return; fi
  echo "__NONE__"
}

install_systemd_units() {
  local node_bin="$1" node_dir="$2"
  local tmp_comfy tmp_svc SUDO
  tmp_comfy="$(mktemp)"; tmp_svc="$(mktemp)"

  sed -e "s#@USER@#$USER#g" -e "s#@COMFYUI@#$COMFYUI_DIR#g" \
      "$SCRIPT_DIR/comfyui.service.template" > "$tmp_comfy"
  sed -e "s#@USER@#$USER#g" -e "s#@REPO@#$REPO_DIR#g" \
      -e "s#@NODE@#$node_bin#g" -e "s#@NODEBIN@#$node_dir#g" \
      "$SCRIPT_DIR/imagegen-service.service.template" > "$tmp_svc"

  # Idempotent: if both units are already installed AND match what we'd write, skip.
  if cmp -s "$tmp_comfy" /etc/systemd/system/comfyui.service 2>/dev/null \
     && cmp -s "$tmp_svc" /etc/systemd/system/imagegen-service.service 2>/dev/null; then
    skip "systemd units already installed and up to date"
    rm -f "$tmp_comfy" "$tmp_svc"; return 0
  fi

  # Already installed, enabled, and running (only the header comments differ) — leave them alone
  # instead of nagging for sudo. A fresh/broken box falls through to the install path below.
  if systemctl_enabled comfyui.service && systemctl_active comfyui.service \
     && systemctl_enabled imagegen-service.service && systemctl_active imagegen-service.service; then
    skip "systemd services already installed, enabled, and running (left as-is)"
    rm -f "$tmp_comfy" "$tmp_svc"; return 0
  fi

  SUDO="$(detect_sudo)"
  if [ "$SUDO" = "__NONE__" ]; then
    warn "Installing the auto-start services needs administrator (sudo) rights, which are not"
    warn "available right now. Run these commands yourself to finish (one time):"
    say  "    sudo cp '$tmp_comfy' /etc/systemd/system/comfyui.service"
    say  "    sudo cp '$tmp_svc' /etc/systemd/system/imagegen-service.service"
    say  "    sudo systemctl daemon-reload"
    say  "    sudo systemctl enable --now comfyui.service imagegen-service.service"
    say  "  (The generated unit files above are kept for you.)"
    return 0
  fi

  say "  Installing auto-start services (systemd) …"
  $SUDO cp "$tmp_comfy" /etc/systemd/system/comfyui.service || die "Failed to install comfyui.service"
  $SUDO cp "$tmp_svc"   /etc/systemd/system/imagegen-service.service || die "Failed to install imagegen-service.service"
  rm -f "$tmp_comfy" "$tmp_svc"
  $SUDO systemctl daemon-reload || die "systemctl daemon-reload failed"
  $SUDO systemctl enable --now comfyui.service imagegen-service.service \
    || die "Failed to enable/start the services"
  ok "Auto-start services installed (comfyui + imagegen-service)"
}

# ================================================================================================
# 5. POSTFLIGHT (start, wait for health, print summary)
# ================================================================================================
http_ok() { curl -fs --max-time 5 -o /dev/null "$1" >/dev/null 2>&1; }

wait_for() {
  local url="$1" label="$2" timeout="${3:-180}" waited=0
  say "  Waiting for $label …"
  while [ "$waited" -lt "$timeout" ]; do
    http_ok "$url" && { ok "$label is up"; return 0; }
    sleep 3; waited=$((waited+3))
  done
  return 1
}

postflight() {
  step "Step 5/5 — Starting everything and checking health"

  # Nudge services up if systemd manages them (harmless if already running / absent).
  local SUDO; SUDO="$(detect_sudo)"
  if [ "$SUDO" != "__NONE__" ]; then
    $SUDO systemctl start comfyui.service imagegen-service.service >/dev/null 2>&1 || true
  fi

  wait_for "http://localhost:$COMFYUI_PORT/system_stats" "ComfyUI (port $COMFYUI_PORT)" 240 \
    || warn "ComfyUI did not answer on port $COMFYUI_PORT yet — it may still be starting."
  if ! wait_for "http://localhost:$SERVICE_PORT/health" "imagegen-service (port $SERVICE_PORT)" 120; then
    say ""
    warn "The service did not report healthy. Check its logs with:"
    say  "    journalctl -u imagegen-service -n 50 --no-pager"
    say  "Then re-run:  bash $0"
    return 1
  fi

  # Read /health for the LoRA count. lorasLoaded is a JSON array of filenames; count its entries.
  local health loaded
  health="$(curl -fs --max-time 5 "http://localhost:$SERVICE_PORT/health" 2>/dev/null)"
  loaded="$(printf '%s' "$health" | grep -oE '"lorasLoaded":\[[^]]*\]' | grep -o '\.safetensors' | wc -l | tr -d ' ')"
  [ -n "$loaded" ] || loaded=0

  local ip; ip="$(hostname -I 2>/dev/null | awk '{print $1}')"; [ -n "$ip" ] || ip="<this-machine-ip>"

  printf '\n%s========================================================%s\n' "$c_grn" "$c_reset"
  printf '%s  SUCCESS — imagegen-service is running.%s\n' "$c_grn$c_bld" "$c_reset"
  printf '%s========================================================%s\n' "$c_grn" "$c_reset"
  say ""
  say "  Test it now:      open  http://localhost:$SERVICE_PORT  in a browser"
  say "  From other PCs:   http://$ip:$SERVICE_PORT"
  say "  Health check:     http://localhost:$SERVICE_PORT/health"
  say "  ComfyUI backend:  http://localhost:$COMFYUI_PORT"
  say ""
  say "  LoRA styles loaded: ${loaded:-unknown}"
  if [ "${#SKIPPED_MODELS[@]}" -gt 0 ]; then
    warn "${#SKIPPED_MODELS[@]} model(s) were skipped (those styles fall back to prompt-only):"
    say  "    ${SKIPPED_MODELS[*]}"
    say  "  Add a working URL for them in install/models.manifest and re-run to fix."
  fi
  say ""
}

# ================================================================================================
# main
# ================================================================================================
main() {
  say "${c_bld}imagegen-service installer (Linux)${c_reset}"
  preflight
  if [ "$CHECK_ONLY" = "1" ]; then
    step "Check mode — no changes were made"
    say "  Preflight complete. Re-run without --check to install."
    exit 0
  fi
  install_comfyui
  install_models
  install_service
  postflight
}
main "$@"
