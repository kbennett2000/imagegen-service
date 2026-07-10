// File-based config, mirroring Chronicle's config pattern. This service reads NO environment
// variables anywhere in src/ (a hard ADR-0001 invariant). Config is loaded once at import,
// deep-merged over built-in defaults, deep-frozen. Resolved relative to this module (not cwd).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  readonly comfyui: { readonly url: string };
  readonly server: { readonly host: string; readonly port: number };
}

// Last-resort defaults (ADR-0001): host 0.0.0.0 is LAN-exposed BY DESIGN.
export const CONFIG_DEFAULTS: Config = {
  comfyui: { url: "http://localhost:8188" },
  server: { host: "0.0.0.0", port: 8189 },
};

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Returns the parsed object, or undefined if absent/unreadable/malformed. Never throws:
// a present-but-broken file is warned about and treated as absent.
function readJsonIfPresent(file: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return undefined; // absent or unreadable
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    console.warn(`[config] ${file} is not valid JSON — ignoring it`);
    return undefined;
  }
}

// Deep-merge nested plain objects; scalars/arrays overwrite. `over` wins.
function deepMerge<T>(base: T, over: Record<string, unknown> | undefined): T {
  if (!over) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    const cur = out[k];
    if (isPlainObject(cur) && isPlainObject(v)) {
      out[k] = deepMerge(cur, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

function deepFreeze<T>(obj: T): T {
  if (isPlainObject(obj)) {
    for (const v of Object.values(obj)) deepFreeze(v);
    Object.freeze(obj);
  }
  return obj;
}

export function loadConfigFrom(dir: string): Config {
  // Prefer config.json; fall back to the committed config.example.json; else pure defaults.
  const override =
    readJsonIfPresent(path.join(dir, "config.json")) ??
    readJsonIfPresent(path.join(dir, "config.example.json"));
  const merged = deepMerge(structuredClone(CONFIG_DEFAULTS), override);
  return deepFreeze(merged);
}

export const config: Config = loadConfigFrom(REPO_ROOT);
