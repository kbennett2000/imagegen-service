import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Guards the two field-confirmed Windows-installer bugs (issue #23):
//   Bug 1 — install-windows.ps1 must be UTF-8 WITH BOM and pure ASCII, or powershell.exe 5.1
//           reads it as ANSI and the em-dash bytes terminate a string early → parse error.
//   Bug 2 — the driver-gate regex must read the CUDA version from BOTH the old "CUDA Version: X.Y"
//           banner and the 610-series "CUDA UMD Version: X.Y" banner.
// Both assertions read the SHIPPED installer, not a copy, so a regression in the file fails here.

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const winInstaller = fileURLToPath(new URL("../install/install-windows.ps1", import.meta.url));

// A realistic nvidia-smi banner, old format (<=550 drivers): "CUDA Version: 12.8".
const OLD_BANNER = [
  "+-----------------------------------------------------------------------------+",
  "| NVIDIA-SMI 550.54.15   Driver Version: 550.54.15   CUDA Version: 12.8        |",
  "|-------------------------------+----------------------+----------------------+",
].join("\n");

// 610-series banner (RTX 5070, driver 610.62): the wording changed to "CUDA UMD Version: 13.3",
// and a separate "KMD Version:" appears earlier on the line.
const NEW_BANNER = [
  "+-----------------------------------------------------------------------------+",
  "| NVIDIA-SMI 610.62   KMD Version: 610.62   CUDA UMD Version: 13.3             |",
  "|-------------------------------+----------------------+----------------------+",
].join("\n");

// Pull the ACTUAL driver-gate regex out of the installer. PowerShell single-quoted strings keep
// backslashes literal, so the captured text is already a valid JS regex source.
function cudaRegexFromInstaller(): RegExp {
  const src = readFileSync(winInstaller, "utf8");
  const line = src.split(/\r?\n/).find((l) => l.includes("-match") && l.includes("CUDA"));
  assert.ok(line, "no CUDA '-match' line found in install-windows.ps1");
  const m = line.match(/-match\s+'([^']+)'/);
  assert.ok(m, `could not extract the regex literal from: ${line}`);
  return new RegExp(m[1]);
}

test("driver-gate regex reads the CUDA version from the old banner (CUDA Version: 12.8)", () => {
  const m = OLD_BANNER.match(cudaRegexFromInstaller());
  assert.ok(m, "old banner did not match");
  assert.equal(m[1], "12.8");
});

test("driver-gate regex reads the CUDA version from the 610-series banner (CUDA UMD Version: 13.3)", () => {
  const m = NEW_BANNER.match(cudaRegexFromInstaller());
  assert.ok(m, "610-series banner did not match");
  assert.equal(m[1], "13.3");
});

test("every tracked *.ps1 is UTF-8 with BOM and pure ASCII after the BOM", () => {
  const listed = execSync('git ls-files "*.ps1"', { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(listed.length > 0, "expected at least one tracked .ps1");
  for (const rel of listed) {
    const bytes = readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)));
    assert.deepEqual(
      [...bytes.subarray(0, 3)],
      [0xef, 0xbb, 0xbf],
      `${rel} is missing the UTF-8 BOM (powershell.exe 5.1 would read it as ANSI)`,
    );
    const offender = bytes.subarray(3).findIndex((b) => b > 0x7f);
    assert.equal(
      offender,
      -1,
      `${rel} has a non-ASCII byte at offset ${offender + 3} ` +
        "(would corrupt under a BOM-stripping ANSI read — keep .ps1 ASCII-only)",
    );
  }
});
