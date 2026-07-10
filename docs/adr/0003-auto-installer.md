# ADR-0003 — Full-stack auto-installer (Windows + Ubuntu), "automate all but the driver"

## Status
Accepted (installer slice)

## Context
ADR-0001 built the service and ADR-0002 added deployment (systemd unit + optional auth). But
getting from a bare machine to a running service still meant a long manual assembly: install an
NVIDIA-capable Python/torch stack, install ComfyUI, hand-download SDXL + 12 LoRAs (several of them
CivitAI login-gated), install Node deps, write `config.json`, and wire up two auto-start services.
That is far beyond a non-technical user, and it is exactly the sequence we performed by hand on the
reference box (RTX 5070, driver 595.71.05 / CUDA 13.2, ComfyUI in a `uv` Python 3.11 venv with
torch cu128).

We want a single script per platform that a non-technical user with a supported NVIDIA GPU can run
to set up the **whole stack the service depends on** — not just the service — and end at a working
`/health`. Two platforms only: **Windows** and **Ubuntu Linux**. No macOS (no CUDA there).

## Decision

### 1. Automate everything EXCEPT the NVIDIA driver
The driver is the one component a script must not silently install: a bad driver swap can break the
user's display, and driver installation is deeply OS/hardware-specific. So the installer **detects
and gates** on the driver instead of touching it. Preflight runs `nvidia-smi`, parses the reported
`CUDA Version:` capability, and requires **≥ 12.8** (the cu128 PyTorch wheels SDXL needs; the
reference box's 13.2 passes). If `nvidia-smi` is absent or the capability is too old, the installer
**STOPS** with a plain-language message: what is wrong, the single official link
(`https://www.nvidia.com/Download/index.aspx`), and "reboot, then run this installer again." It
never attempts a driver install. GPU name + VRAM are reported; VRAM below ~11 GB **warns but does
not block** (SDXL + a LoRA wants headroom). Everything downstream of a working driver is automated.

### 2. Reuse the proven environment recipe
ComfyUI installs into `~/comfyui` (Linux) / `%USERPROFILE%\comfyui` (Windows) in its **own isolated
`uv` Python 3.11 venv**, with **torch built against CUDA 12.8** (`--index-url
https://download.pytorch.org/whl/cu128`) — exactly the versions proven on the reference box.
ComfyUI-Manager is installed into `custom_nodes`. `uv` is installed via its official installer if
absent.

### 3. Model downloads: one manifest, CivitAI source + ungated mirror, verify, warn-and-continue
All model files live in one readable table, `install/models.manifest`
(`subdir|dest-filename|primary-url|fallback-url|min-megabytes`), read by **both** installers so the
URL list has a single home. SDXL base/refiner/VAE come from Stability's canonical ungated Hugging
Face repos. For the 12 LoRAs, the **primary** URL is the CivitAI source where a version-pinned
direct download was resolved; the **fallback** is an ungated Hugging Face mirror of the same file.
CivitAI direct links are often login-gated — when a primary is gated it returns an HTML/JSON login
page, which fails verification and the fallback is used. That is the whole point of the fallback
column.

Every file is **verified as a real `.safetensors`**: size ≥ the manifest floor **and** a valid
safetensors header (the leading 8-byte little-endian header length is `0 < N < filesize` and byte 8
opens the JSON header with `{`). A few-KB error page fails both checks. If a file cannot be fetched
from any source, the installer **WARNs and continues** (that style degrades to prompt-only) rather
than failing the whole install. Two LoRAs shipped without a confirmed same-file source
(`watercolor-orie-xl`, and `sketch_style` as a functional substitute) are documented inline in the
manifest and surface in the postflight "skipped" summary.

### 4. Both processes as reboot-surviving auto-start services
- **Linux:** systemd units for `comfyui` and `imagegen-service`, generated per-machine from
  `install/*.service.template` (placeholders `@USER@/@REPO@/@NODE@/@NODEBIN@/@COMFYUI@`). We keep
  the **nvm-safe absolute-node ExecStart** pattern from ADR-0002 / the reference `comfyui.service`:
  `node` is resolved with `command -v node` and its absolute path is embedded, never a bare `npm`
  (which fails under systemd's stripped PATH with status=203/EXEC). Unit install needs root, so the
  installer uses non-interactive `sudo` when available; if it is not, it writes the generated units
  and prints the exact `sudo cp / daemon-reload / enable --now` commands and continues.
- **Windows:** **NSSM** services (`ComfyUI`, `imagegen-service`). NSSM was chosen over Task
  Scheduler at-logon because it gives true services that start at boot without a login and restart
  on crash — the closest analogue to systemd. The installer downloads NSSM, registers each service
  with `AppDirectory` + `AppParameters`, `Start SERVICE_AUTO_START`, and `AppExit Default Restart`.
  Node is invoked by its absolute path (the Windows analogue of the nvm-PATH fix). Service
  registration needs an elevated shell; without one the installer explains how to re-run as
  Administrator and continues.

### 5. Idempotent, with a CI-safe `--check` mode
Both scripts are re-runnable: every step checks what already exists (checkout, venv, torch,
ComfyUI-Manager, each model file, node_modules, config.json, the services) and skips it, so a
re-run makes no destructive change. Because these scripts run on the target machine and cannot be
unit-tested against a real GPU in CI, each has a **`--check` / `-Check`** mode that runs preflight
only — detect OS, GPU, driver/CUDA, disk, and which components are already present — and reports
without changing anything. That is the CI-safe and user-reassurance path.

## Consequences
- A non-technical user runs one script and gets the full stack; the only manual prerequisite is a
  working NVIDIA driver, which the installer checks for and explains how to obtain.
- The service's engine/API and config approach are untouched: still `config.json`-only, **no env
  vars** anywhere in `src/`.
- The manifest is the single place to fix or add a model URL; a maintainer filling in the two
  unresolved LoRA sources needs to touch only that file.
- On a fresh box, `sudo` (Linux) / an elevated shell (Windows) is required for the service-install
  step; the installer degrades gracefully to printed instructions when privileges are unavailable
  (this is why the headless build cycle, which has no sudo, leaves already-installed units as-is).
- Full user documentation is deliberately a later docs slice; README gets only a short "Quick
  install" pointer here.

## Verify
- `bash install/install-linux.sh --check` on the reference box reports Ubuntu, the RTX 5070 /
  12 GB (no VRAM warn), driver 595.71.05 / CUDA 13.2 **PASS**, disk OK, and every component already
  present — changing nothing.
- A real `bash install/install-linux.sh` is idempotent: it skips all present components, installs
  only what is genuinely missing, and ends at a green `/health` reporting 12 LoRAs loaded.
- Mocking `nvidia-smi` to report CUDA 12.2 (too old) or removing it makes preflight **STOP** with
  the friendly driver message and a non-zero exit — no install is attempted.
- `bash -n install/install-linux.sh` passes; the PowerShell script is validated by review (no
  Windows/pwsh in CI).
- `grep -rn process.env src/` remains empty; the installer writes only `config.json`.
