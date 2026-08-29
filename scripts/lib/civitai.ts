// Civitai download auth, shared by the TS fetch scripts (fetch-wan22-models.ts and future ones).
//
// The token is a DOWNLOAD-TIME secret. It is read from the gitignored `install/secrets.env` FILE
// (a KEY=VALUE file, never `process.env`) so scripts stay consistent with the src/ no-env invariant
// (ADR-0001). A caller may still pass an explicit override (from a --civitai-token flag), which
// wins over the file.
//
// The Bearer header is attached ONLY for civitai.com hosts — a token must never leak to Hugging
// Face or any other mirror.

import { readFileSync } from "node:fs";
import path from "node:path";

// Parse a secrets.env body for CIVITAI_TOKEN. Ignores blank lines and `#` comments; strips a single
// pair of surrounding quotes. Returns "" when the key is absent. Pure — unit-tested without a file.
export function parseCivitaiToken(raw: string): string {
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    if (line.slice(0, eq).trim() !== "CIVITAI_TOKEN") continue;
    let val = line.slice(eq + 1).trim();
    if (
      val.length >= 2 &&
      ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    ) {
      val = val.slice(1, -1);
    }
    return val;
  }
  return "";
}

// Read CIVITAI_TOKEN from `<repoRoot>/install/secrets.env`. Returns "" if the file is absent,
// unreadable, or has no token. Never throws.
export function readCivitaiTokenFile(repoRoot: string): string {
  try {
    return parseCivitaiToken(readFileSync(path.join(repoRoot, "install", "secrets.env"), "utf8"));
  } catch {
    return "";
  }
}

// Resolve the token to use: an explicit override (e.g. a --civitai-token flag) wins; otherwise the
// secrets file. Kept env-free by design — the shell installer handles the $CIVITAI_TOKEN env path.
export function resolveCivitaiToken(repoRoot: string, override?: string | null): string {
  const o = (override ?? "").trim();
  return o || readCivitaiTokenFile(repoRoot);
}

// True only for civitai.com and its subdomains. Anything unparseable or any other host is false, so
// the token is never attached to it.
export function isCivitaiUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "civitai.com" || host.endsWith(".civitai.com");
}

// The extra curl args for a URL: the Bearer header ONLY when the host is civitai.com AND a token is
// present. Empty for every other host (HF, etc.) and when there is no token — so a plain HF download
// is byte-for-byte what it was before.
export function civitaiCurlArgs(url: string, token: string): string[] {
  if (token && isCivitaiUrl(url)) return ["-H", `Authorization: Bearer ${token}`];
  return [];
}
