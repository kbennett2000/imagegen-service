<#
  install-windows.ps1 - full-stack auto-installer for imagegen-service on Windows.

  Takes a machine with a WORKING NVIDIA driver from nothing to a running service:
    ComfyUI (isolated uv Python 3.11 venv, torch cu128) + ComfyUI-Manager, SDXL base/refiner/VAE,
    the 12 style LoRAs, this repo's Node deps, config.json, and BOTH auto-start NSSM services.

  GUIDING PRINCIPLE: automate everything EXCEPT the NVIDIA driver. We DETECT the driver/CUDA and,
  if it is missing or too old, STOP with a plain-language message + the official link - we never
  install or change the driver (that can break your display).

  Idempotent: safe to re-run. Every step checks what is already there and skips it.

  Usage (open PowerShell, then):
    powershell -ExecutionPolicy Bypass -File install\install-windows.ps1           # full install
    powershell -ExecutionPolicy Bypass -File install\install-windows.ps1 -Check    # preflight only
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [Alias('DryRun')][switch]$DryRunAlias
)

$ErrorActionPreference = 'Stop'
if ($DryRunAlias) { $Check = $true }

# ------------------------------------------------------------------------------------------------
# Paths & constants
# ------------------------------------------------------------------------------------------------
$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoDir     = Split-Path -Parent $ScriptDir
$Manifest    = Join-Path $ScriptDir 'models.manifest'
$ComfyDir    = Join-Path $env:USERPROFILE 'comfyui'
$ComfyRepo   = 'https://github.com/comfyanonymous/ComfyUI.git'
$ManagerRepo = 'https://github.com/ltdrdata/ComfyUI-Manager.git'
$TorchIndex  = 'https://download.pytorch.org/whl/cu128'
$PyVersion   = '3.11'
$MinCudaMM   = 1208            # cu128 wheels need CUDA capability >= 12.8
$VramWarnMiB = 11000
$ComfyPort   = 8188
$ServicePort = 8189
$DriverLink  = 'https://www.nvidia.com/Download/index.aspx'
$NssmUrl     = 'https://nssm.cc/release/nssm-2.24.zip'
$NssmDir     = Join-Path $ComfyDir 'nssm'
$Script:Skipped = @()

# ------------------------------------------------------------------------------------------------
# Output helpers (plain language)
# ------------------------------------------------------------------------------------------------
function Say  ($m) { Write-Host $m }
function Step ($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok   ($m) { Write-Host "  ok: $m"      -ForegroundColor Green }
function Warn ($m) { Write-Host "  warning: $m" -ForegroundColor Yellow }
function Skip ($m) { Write-Host "  skip: $m" }
function Die  ($m, $hint) {
  Write-Host "`nerror: $m" -ForegroundColor Red
  if ($hint) { Write-Host "  $hint" }
  Write-Host "`nFix the problem above, then run this installer again:"
  Write-Host "  powershell -ExecutionPolicy Bypass -File install\install-windows.ps1"
  exit 1
}

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltinRole]::Administrator)
}

# ================================================================================================
# 1. PREFLIGHT / DRIVER GATE
# ================================================================================================
function Invoke-Preflight {
  Step 'Step 1/5 - Checking your system'

  if (-not $IsWindows -and $PSVersionTable.Platform -ne 'Win32NT' -and $env:OS -ne 'Windows_NT') {
    Die 'This installer is for Windows. On Linux use install/install-linux.sh instead.'
  }
  Ok "Operating system: Windows ($([Environment]::OSVersion.VersionString))"

  # --- NVIDIA driver gate (never auto-installed) ---
  if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
    Say ''
    Say '  No NVIDIA driver was found (nvidia-smi is not installed).'
    Say '  imagegen-service needs an NVIDIA GPU with a recent driver.'
    Say ''
    Say "  1. Install the official NVIDIA driver:  $DriverLink"
    Say '  2. Reboot your computer.'
    Say '  3. Run this installer again.'
    Die 'NVIDIA driver not detected.'
  }

  $q = (& nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>$null |
        Select-Object -First 1)
  $parts     = $q -split '\s*,\s*'
  $gpuName   = $parts[0]
  $vramMiB   = [int]($parts[1])
  $driverVer = $parts[2]

  $banner  = (& nvidia-smi 2>$null | Out-String)
  $cudaCap = if ($banner -match 'CUDA (?:UMD )?Version:\s*([0-9]+\.[0-9]+)') { $Matches[1] } else { $null }
  if (-not $cudaCap) {
    Die 'Could not read the CUDA version from your NVIDIA driver.' `
        "Reinstall/upgrade the official driver ($DriverLink), reboot, and re-run."
  }
  $cMaj, $cMin = $cudaCap -split '\.'
  $cudaMM = [int]$cMaj * 100 + [int]$cMin

  Ok "GPU: $gpuName  ($vramMiB MiB VRAM)"
  Ok "NVIDIA driver: $driverVer  (CUDA capability $cudaCap)"

  if ($cudaMM -lt $MinCudaMM) {
    Say ''
    Say "  Your NVIDIA driver supports CUDA $cudaCap, but SDXL needs CUDA 12.8 or newer"
    Say '  (the cu128 PyTorch build). Your driver is too old.'
    Say ''
    Say "  1. Update the official NVIDIA driver:  $DriverLink"
    Say '  2. Reboot your computer.'
    Say '  3. Run this installer again.'
    Die 'NVIDIA driver too old for CUDA 12.8 (cu128).'
  }

  if ($vramMiB -lt $VramWarnMiB) {
    Warn "Your GPU has $vramMiB MiB VRAM. SDXL + a LoRA is happiest with ~11 GB+; it may run"
    Warn 'slowly or run out of memory on large images. Continuing anyway.'
  }

  # --- Disk space ---
  $drive   = (Get-Item $env:USERPROFILE).PSDrive.Name
  $freeGb  = [math]::Round((Get-PSDrive $drive).Free / 1GB)
  if ($freeGb -lt 30) { Warn "Only ~$freeGb GB free on ${drive}:. The full stack needs ~30 GB." }
  else                { Ok "Disk space: ~$freeGb GB free on ${drive}:" }

  # --- Existing installs (informational; drives idempotent skips) ---
  Say ''
  Say '  Already present on this machine:'
  Report-Present 'ComfyUI checkout'         (Test-Path (Join-Path $ComfyDir 'main.py'))
  Report-Present 'ComfyUI Python venv'      (Test-Path (Join-Path $ComfyDir '.venv\Scripts\python.exe'))
  Report-Present 'PyTorch (cu128)'          (Test-ComfyTorch)
  Report-Present 'ComfyUI-Manager'          (Test-Path (Join-Path $ComfyDir 'custom_nodes\ComfyUI-Manager'))
  Report-Present 'Node.js'                  ([bool](Get-Command node -ErrorAction SilentlyContinue))
  Report-Present 'Service deps (node_modules)' (Test-Path (Join-Path $RepoDir 'node_modules'))
  Report-Present 'config.json'              (Test-Path (Join-Path $RepoDir 'config.json'))
  Report-Present 'ComfyUI service (NSSM)'   ([bool](Get-Service 'ComfyUI' -ErrorAction SilentlyContinue))
  Report-Present 'imagegen-service (NSSM)'  ([bool](Get-Service 'imagegen-service' -ErrorAction SilentlyContinue))
  Report-Models
}

function Report-Present ($label, $present) {
  if ($present) { Say "    [x] $label" } else { Say "    [ ] $label" }
}
function Report-Models {
  if (-not (Test-Path $Manifest)) { return }
  $present = 0; $total = 0
  foreach ($row in Read-Manifest) {
    $total++
    if (Test-Path (Join-Path $ComfyDir "models\$($row.Subdir)\$($row.File)")) { $present++ }
  }
  $mark = if ($present -eq $total) { 'x' } else { ' ' }
  Say "    [$mark] Model files: $present / $total present"
}
function Test-ComfyPython { Join-Path $ComfyDir '.venv\Scripts\python.exe' }
function Test-ComfyTorch {
  $py = Test-ComfyPython
  if (-not (Test-Path $py)) { return $false }
  & $py -c 'import torch,sys; sys.exit(0 if torch.cuda.is_available() else 1)' 2>$null
  return ($LASTEXITCODE -eq 0)
}

# ================================================================================================
# Manifest parsing (shared with the Linux installer's models.manifest)
# ================================================================================================
function Read-Manifest {
  Get-Content $Manifest | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { return }
    $c = $line -split '\|'
    if ($c.Count -lt 5) { return }
    [pscustomobject]@{
      Subdir = $c[0].Trim(); File = $c[1].Trim()
      Primary = $c[2].Trim(); Fallback = $c[3].Trim(); MinMB = [int]$c[4].Trim()
    }
  }
}

# ================================================================================================
# 2. COMFYUI
# ================================================================================================
function Ensure-Uv {
  if (Get-Command uv -ErrorAction SilentlyContinue) { return }
  $uvLocal = Join-Path $env:USERPROFILE '.local\bin'
  if (Test-Path (Join-Path $uvLocal 'uv.exe')) { $env:Path = "$uvLocal;$env:Path"; return }
  Say '  Installing uv (fast Python env manager)...'
  powershell -ExecutionPolicy Bypass -Command 'irm https://astral.sh/uv/install.ps1 | iex' | Out-Null
  $env:Path = "$uvLocal;$env:Path"
  if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { Die 'uv installed but not on PATH.' }
}

function Install-ComfyUI {
  Step 'Step 2/5 - Installing ComfyUI'
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Die 'Git is required but was not found.' 'Install Git for Windows (https://git-scm.com/download/win), then re-run.'
  }
  Ensure-Uv

  if (Test-Path (Join-Path $ComfyDir 'main.py')) {
    Skip "ComfyUI already checked out at $ComfyDir"
  } else {
    Say "  Downloading ComfyUI to $ComfyDir ..."
    git clone --depth 1 $ComfyRepo $ComfyDir
    if ($LASTEXITCODE -ne 0) { Die 'Failed to clone ComfyUI.' }
    Ok 'ComfyUI downloaded'
  }

  $py = Test-ComfyPython
  if (Test-Path $py) {
    Skip 'Python venv already exists'
  } else {
    Say "  Creating an isolated Python $PyVersion environment ..."
    uv venv --python $PyVersion (Join-Path $ComfyDir '.venv')
    if ($LASTEXITCODE -ne 0) { Die 'Failed to create the Python venv.' }
    Ok "Python $PyVersion environment ready"
  }

  if (Test-ComfyTorch) {
    Skip 'PyTorch with CUDA already working'
  } else {
    Say '  Installing PyTorch (CUDA 12.8 build) - this is a large download ...'
    uv pip install --python $py torch torchvision --index-url $TorchIndex
    if ($LASTEXITCODE -ne 0) { Die 'Failed to install PyTorch (cu128).' }
    if (-not (Test-ComfyTorch)) { Die 'PyTorch installed but CUDA is not available to it.' 'Confirm the NVIDIA driver is loaded (nvidia-smi) and re-run.' }
    Ok 'PyTorch (cu128) installed and sees the GPU'
  }

  $depsSentinel = Join-Path $ComfyDir '.venv\.imagegen_deps_ok'
  if (Test-Path $depsSentinel) {
    Skip 'ComfyUI dependencies already installed'
  } else {
    Say '  Installing ComfyUI dependencies ...'
    uv pip install --python $py -r (Join-Path $ComfyDir 'requirements.txt') | Out-Null
    if ($LASTEXITCODE -ne 0) { Die 'Failed to install ComfyUI requirements.' }
    New-Item -ItemType File -Path $depsSentinel -Force | Out-Null
    Ok 'ComfyUI dependencies installed'
  }

  $mgr = Join-Path $ComfyDir 'custom_nodes\ComfyUI-Manager'
  if (Test-Path $mgr) {
    Skip 'ComfyUI-Manager already installed'
  } else {
    Say '  Installing ComfyUI-Manager ...'
    git clone --depth 1 $ManagerRepo $mgr
    if ($LASTEXITCODE -eq 0) {
      $mgrReq = Join-Path $mgr 'requirements.txt'
      if (Test-Path $mgrReq) { uv pip install --python $py -r $mgrReq 2>$null | Out-Null }
      Ok 'ComfyUI-Manager installed'
    } else { Warn 'Could not install ComfyUI-Manager (non-fatal); continuing.' }
  }
}

# ================================================================================================
# 3. MODELS (download-with-mirror-fallback + real-safetensors verification)
# ================================================================================================
# A .safetensors file starts with an 8-byte little-endian header length N, then N bytes of JSON
# beginning with '{'. HTML/JSON error pages fail size and/or this header check.
function Test-Safetensors ($path, $minMB) {
  if (-not (Test-Path $path)) { return $false }
  $size = (Get-Item $path).Length
  if ($size -lt ($minMB * 1MB)) { return $false }
  $fs = [IO.File]::OpenRead($path)
  try {
    if ($fs.Length -lt 9) { return $false }
    $buf = New-Object byte[] 9
    [void]$fs.Read($buf, 0, 9)
    $n = [BitConverter]::ToUInt64($buf, 0)
    if ($n -le 0 -or $n -ge [uint64]$size) { return $false }
    if ($buf[8] -ne 0x7B) { return $false }   # '{'
    return $true
  } finally { $fs.Close() }
}

function Get-File ($url, $dest) {
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -fL --retry 3 --retry-delay 2 --connect-timeout 30 -o $dest $url
    return ($LASTEXITCODE -eq 0)
  }
  try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing; return $true }
  catch { return $false }
}

function Get-Verified ($row) {
  $dir  = Join-Path $ComfyDir "models\$($row.Subdir)"
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  $dest = Join-Path $dir $row.File
  if (Test-Safetensors $dest $row.MinMB) { Skip "$($row.File) (already present)"; return }

  $tmp = "$dest.part"
  foreach ($url in @($row.Primary, $row.Fallback)) {
    if (-not $url -or $url -eq '-') { continue }
    Say "  Downloading $($row.File) ..."
    Remove-Item $tmp -ErrorAction SilentlyContinue
    if ((Get-File $url $tmp) -and (Test-Safetensors $tmp $row.MinMB)) {
      Move-Item -Force $tmp $dest; Ok $row.File; return
    }
    Warn "Source failed or was not a valid model file; trying the next source for $($row.File)"
  }
  Remove-Item $tmp -ErrorAction SilentlyContinue
  Warn "Could not fetch $($row.File) from any source - the matching style will fall back to prompt-only."
  $Script:Skipped += $row.File
}

function Install-Models {
  Step 'Step 3/5 - Downloading models (SDXL + LoRAs)'
  if (-not (Test-Path $Manifest)) { Die "Model manifest not found at $Manifest" }
  foreach ($row in Read-Manifest) { Get-Verified $row }
  if ($Script:Skipped.Count -gt 0) {
    Warn "$($Script:Skipped.Count) model(s) could not be downloaded: $($Script:Skipped -join ', ')"
  } else { Ok 'All model files present' }
}

# ================================================================================================
# 4. THE SERVICE (Node deps + config.json + NSSM services)
# ================================================================================================
function Ensure-Node {
  if (Get-Command node -ErrorAction SilentlyContinue) { return }
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Say '  Node.js not found - installing the LTS via winget ...'
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements | Out-Null
    $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
                [Environment]::GetEnvironmentVariable('Path','User')
  }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Die 'Node.js is required but could not be installed automatically.' `
        'Install the Node.js LTS from https://nodejs.org/en/download, then re-run.'
  }
}

function Ensure-Nssm {
  $nssmExe = Join-Path $NssmDir 'nssm.exe'
  if (Test-Path $nssmExe) { return $nssmExe }
  Say '  Downloading NSSM (service manager) ...'
  New-Item -ItemType Directory -Path $NssmDir -Force | Out-Null
  $zip = Join-Path $NssmDir 'nssm.zip'
  if (-not (Get-File $NssmUrl $zip)) { Die 'Failed to download NSSM.' 'Check your internet connection and re-run.' }
  Expand-Archive -Path $zip -DestinationPath $NssmDir -Force
  $arch = if ([Environment]::Is64BitOperatingSystem) { 'win64' } else { 'win32' }
  $found = Get-ChildItem -Path $NssmDir -Recurse -Filter 'nssm.exe' |
           Where-Object { $_.FullName -match $arch } | Select-Object -First 1
  if (-not $found) { $found = Get-ChildItem -Path $NssmDir -Recurse -Filter 'nssm.exe' | Select-Object -First 1 }
  if (-not $found) { Die 'NSSM downloaded but nssm.exe was not found in the archive.' }
  Copy-Item $found.FullName $nssmExe -Force
  return $nssmExe
}

function Install-Service {
  Step 'Step 4/5 - Setting up the imagegen-service'
  Ensure-Node
  $nodeExe = (Get-Command node).Source
  $nodeDir = Split-Path -Parent $nodeExe
  Ok "Node.js: $nodeExe"

  if (Test-Path (Join-Path $RepoDir 'node_modules')) {
    Skip 'Service dependencies already installed'
  } else {
    Say '  Installing service dependencies ...'
    Push-Location $RepoDir
    try { npm install | Out-Null; if ($LASTEXITCODE -ne 0) { Die 'npm install failed.' } }
    finally { Pop-Location }
    Ok 'Service dependencies installed'
  }

  $cfg = Join-Path $RepoDir 'config.json'
  if (Test-Path $cfg) {
    Skip 'config.json already present (left untouched)'
  } else {
    Copy-Item (Join-Path $RepoDir 'config.example.json') $cfg
    Ok "Wrote config.json (ComfyUI at localhost:$ComfyPort, service on $ServicePort)"
  }

  Install-NssmServices $nodeExe $nodeDir
}

function Install-NssmServices ($nodeExe, $nodeDir) {
  $haveComfy = [bool](Get-Service 'ComfyUI' -ErrorAction SilentlyContinue)
  $haveSvc   = [bool](Get-Service 'imagegen-service' -ErrorAction SilentlyContinue)
  if ($haveComfy -and $haveSvc) { Skip 'Windows services already installed (left as-is)'; return }

  if (-not (Test-Admin)) {
    Warn 'Installing the auto-start services needs an Administrator PowerShell.'
    Warn 'Right-click PowerShell -> "Run as administrator", then re-run this installer:'
    Say  '    powershell -ExecutionPolicy Bypass -File install\install-windows.ps1'
    return
  }

  $nssm = Ensure-Nssm
  $py   = Test-ComfyPython

  if (-not $haveComfy) {
    Say '  Registering the ComfyUI service ...'
    # AppDirectory is ComfyDir, so main.py is relative. Args go via AppParameters (robust across nssm versions).
    & $nssm install ComfyUI $py | Out-Null
    & $nssm set ComfyUI AppDirectory $ComfyDir | Out-Null
    & $nssm set ComfyUI AppParameters "main.py --listen 0.0.0.0 --port $ComfyPort" | Out-Null
    & $nssm set ComfyUI Start SERVICE_AUTO_START | Out-Null
    & $nssm set ComfyUI AppExit Default Restart | Out-Null
    Ok 'ComfyUI service registered'
  }

  if (-not $haveSvc) {
    Say '  Registering the imagegen-service ...'
    # Invoke node by its ABSOLUTE path (the Windows analogue of the systemd nvm-PATH fix): a bare
    # `npm`/`node` may not be on the SYSTEM service PATH. AppParameters mirror `tsx src/index.ts`.
    & $nssm install imagegen-service $nodeExe | Out-Null
    & $nssm set imagegen-service AppDirectory $RepoDir | Out-Null
    & $nssm set imagegen-service AppParameters '--import tsx src/index.ts' | Out-Null
    & $nssm set imagegen-service Start SERVICE_AUTO_START | Out-Null
    & $nssm set imagegen-service AppExit Default Restart | Out-Null
    # Give the service node's own dir on PATH so any child process it spawns can find node's siblings.
    & $nssm set imagegen-service AppEnvironmentExtra "PATH=$nodeDir;$env:Path" | Out-Null
    Ok 'imagegen-service registered'
  }

  Start-Service ComfyUI -ErrorAction SilentlyContinue
  Start-Service imagegen-service -ErrorAction SilentlyContinue
  Ok 'Auto-start services installed (ComfyUI + imagegen-service)'
}

# ================================================================================================
# 5. POSTFLIGHT
# ================================================================================================
function Test-HttpOk ($url) {
  try { Invoke-WebRequest -Uri $url -TimeoutSec 5 -UseBasicParsing | Out-Null; return $true }
  catch { return $false }
}
function Wait-For ($url, $label, $timeoutSec = 180) {
  Say "  Waiting for $label ..."
  $waited = 0
  while ($waited -lt $timeoutSec) {
    if (Test-HttpOk $url) { Ok "$label is up"; return $true }
    Start-Sleep -Seconds 3; $waited += 3
  }
  return $false
}

function Invoke-Postflight {
  Step 'Step 5/5 - Starting everything and checking health'
  Start-Service ComfyUI -ErrorAction SilentlyContinue
  Start-Service imagegen-service -ErrorAction SilentlyContinue

  if (-not (Wait-For "http://localhost:$ComfyPort/system_stats" "ComfyUI (port $ComfyPort)" 240)) {
    Warn "ComfyUI did not answer on port $ComfyPort yet - it may still be starting."
  }
  if (-not (Wait-For "http://localhost:$ServicePort/health" "imagegen-service (port $ServicePort)" 120)) {
    Say ''
    Warn 'The service did not report healthy. Check the service logs (Event Viewer / NSSM), then re-run.'
    return
  }

  $loaded = 'unknown'
  try {
    $h = Invoke-RestMethod -Uri "http://localhost:$ServicePort/health" -TimeoutSec 5
    if ($h.lorasLoaded) { $loaded = @($h.lorasLoaded).Count }
  } catch {}

  $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
         Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' } |
         Select-Object -First 1).IPAddress
  if (-not $ip) { $ip = '<this-machine-ip>' }

  Write-Host "`n========================================================" -ForegroundColor Green
  Write-Host '  SUCCESS - imagegen-service is running.' -ForegroundColor Green
  Write-Host "========================================================" -ForegroundColor Green
  Say ''
  Say "  Test it now:      open  http://localhost:$ServicePort  in a browser"
  Say "  From other PCs:   http://${ip}:$ServicePort"
  Say "  Health check:     http://localhost:$ServicePort/health"
  Say "  ComfyUI backend:  http://localhost:$ComfyPort"
  Say ''
  Say "  LoRA styles loaded: $loaded"
  if ($Script:Skipped.Count -gt 0) {
    Warn "$($Script:Skipped.Count) model(s) were skipped (those styles fall back to prompt-only):"
    Say  "    $($Script:Skipped -join ', ')"
    Say  '  Add a working URL for them in install/models.manifest and re-run to fix.'
  }
  Say ''
}

# ================================================================================================
# main
# ================================================================================================
Write-Host 'imagegen-service installer (Windows)'
Invoke-Preflight
if ($Check) {
  Step 'Check mode - no changes were made'
  Say '  Preflight complete. Re-run without -Check to install.'
  exit 0
}
Install-ComfyUI
Install-Models
Install-Service
Invoke-Postflight
