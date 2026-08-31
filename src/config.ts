// File-based config, mirroring Chronicle's config pattern. This service reads NO environment
// variables anywhere in src/ (a hard ADR-0001 invariant). Config is loaded once at import,
// deep-merged over built-in defaults, deep-frozen. Resolved relative to this module (not cwd).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  // `checkpoint` is the default base SDXL checkpoint (as ComfyUI lists it, e.g.
  // "sd_xl_base_1.0.safetensors"). Empty string => keep the workflow template's own default. A
  // per-request `checkpoint` overrides this (ADR-0004).
  // `upscaleModel` is the default upscale model (as ComfyUI lists it, e.g. "RealESRGAN_x4plus.pth").
  // Empty string => auto-pick the first installed model when a request asks to upscale (ADR-0006).
  readonly comfyui: { readonly url: string; readonly checkpoint: string; readonly upscaleModel: string };
  readonly server: { readonly host: string; readonly port: number };
  // Optional shared-token auth (ADR-0002). Disabled by default: fully open on the trusted LAN,
  // matching the open-ComfyUI/Chronicle stance. The token gates /generate + /styles for the
  // case where a non-trusted device might join; /health stays open regardless.
  readonly auth: { readonly enabled: boolean; readonly token: string };
  // Shared-flock GPU tenancy lease (ADR-0012). This service and text-transform-service take turns
  // owning the one GPU via an advisory lock on `path` — which MUST be byte-identical on both sides.
  // `maxHoldMs` bounds one lease before yielding (non-preemptive; sized above a full Wan render so a
  // video never self-yields). `idleGraceMs` keeps the lock briefly after the last job drains, so a
  // burst reloads the checkpoint once. `acquireTimeoutMs` bounds the blocking wait before failing
  // open. `enabled` is the kill-switch; false => behave exactly as the pre-lock service.
  readonly gpuLock: {
    readonly path: string;
    readonly maxHoldMs: number;
    readonly idleGraceMs: number;
    readonly acquireTimeoutMs: number;
    readonly enabled: boolean;
  };
}

// Last-resort defaults (ADR-0001): host 0.0.0.0 is LAN-exposed BY DESIGN.
// auth OFF by default (ADR-0002): behavior identical to the open Slice-1 service.
export const CONFIG_DEFAULTS: Config = {
  comfyui: { url: "http://localhost:8188", checkpoint: "", upscaleModel: "" },
  server: { host: "0.0.0.0", port: 8189 },
  auth: { enabled: false, token: "" },
  // /var/lock is world-writable (sticky) so the non-root service user (kb) can create the lockfile;
  // /run needs root and would silently fail open, stranding VRAM. Byte-identical to
  // text-transform-service's GPU_LOCK_PATH so the two services share the one advisory flock.
  // maxHoldMs 21 min > ANIMATE_TIMEOUT_MS (20 min) so a full Wan render finishes without self-yielding.
  gpuLock: {
    path: "/var/lock/gpu-tenant.lock",
    maxHoldMs: 1_260_000,
    idleGraceMs: 5_000,
    acquireTimeoutMs: 120_000,
    enabled: true,
  },
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
