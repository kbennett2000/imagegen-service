// HTTP layer: Node built-in http server, no web framework. Routes — POST /generate, POST /animate,
// POST /stitch, GET /styles, GET /health (+ the dev UI at GET /). Handlers NEVER throw and NEVER leak
// a stack: every failure returns a JSON error body with an appropriate status.

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Config } from "./config.js";
import {
  animateImage,
  DEFAULT_CHECKPOINT,
  generateImage,
  probeComfy,
  QUALITIES,
  wanModelsMissing,
  type AnimateParams,
  type FetchFn,
  type GenerateParams,
  type Quality,
} from "./engine.js";
import { GpuLease, type LockProvider } from "./gpu-lease.js";
import { STYLE_LORAS } from "./style-loras.js";
import { CHECKPOINTS, resolveCheckpoint } from "./checkpoints.js";
import { ffmpegAvailable as ffmpegAvailableDefault, stitchVideos as stitchVideosDefault, type StitchResult } from "./stitch.js";
import { MAX_FRAMES } from "./wan-workflow.js";
import { ANIMATE_MODELS, isAnimateModel } from "./video-models.js";

// CreateVideo caps fps at 120.
const MAX_FPS = 120;

// Generous cap. Raised from 1 MB to accommodate base64 reference images (a 1024² portrait PNG is
// ~1.5 MB raw → ~2 MB base64); a few references still fit comfortably.
const MAX_BODY_BYTES = 16_000_000;

// /stitch uploads whole mp4 clips (base64), which are far larger than images — give that route its
// own cap. 256 MB comfortably holds a sequence of several-second clips (ADR-0010).
const MAX_STITCH_BODY_BYTES = 256_000_000;
const MAX_CLIPS = 50;

// Injectable server dependencies (ADR-0010): the ffmpeg-backed stitcher + availability probe, so unit
// tests cover the /stitch 200 path and /health flag with no ffmpeg. Default to the real ones.
export interface ServerDeps {
  stitchVideos?: (clips: Buffer[]) => Promise<StitchResult>;
  ffmpegAvailable?: () => Promise<boolean>;
  // Shared-flock GPU lease provider (ADR-0012), injected in tests to drive the lease with an
  // in-memory lock (no filesystem, no real flock). Default: the real flock(1)-backed provider.
  lockProvider?: LockProvider;
}

// The built-in dev/test page, served at GET / and GET /index.html. Read once at module load
// (resolves next to this file regardless of cwd) so requests serve from memory. Self-contained —
// inline CSS + vanilla JS, no external requests, no build step.
const UI_HTML = readFileSync(new URL("./ui.html", import.meta.url), "utf8");

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendPng(res: ServerResponse, bytes: Buffer): void {
  res.writeHead(200, { "content-type": "image/png", "content-length": String(bytes.length) });
  res.end(bytes);
}

function sendBytes(res: ServerResponse, bytes: Buffer, contentType: string): void {
  res.writeHead(200, { "content-type": contentType, "content-length": String(bytes.length) });
  res.end(bytes);
}

function readBody(req: IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Validate + normalize the /generate body. Returns either params or a 422 error message.
function parseGenerateBody(raw: string): { params: GenerateParams } | { error: string } {
  let body: unknown;
  try {
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { error: "request body is not valid JSON" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.prompt !== "string" || b.prompt.trim() === "") {
    return { error: "`prompt` is required and must be a non-empty string" };
  }
  if (b.negativePrompt !== undefined && typeof b.negativePrompt !== "string") {
    return { error: "`negativePrompt` must be a string" };
  }
  if (b.style !== undefined && typeof b.style !== "string") {
    return { error: "`style` must be a string" };
  }
  if (b.checkpoint !== undefined) {
    const err = checkpointError(b.checkpoint);
    if (err) return { error: err };
  }
  if (b.quality !== undefined && !QUALITIES.includes(b.quality as Quality)) {
    return { error: `\`quality\` must be one of ${QUALITIES.join(", ")}` };
  }
  if (b.seed !== undefined && (typeof b.seed !== "number" || !Number.isFinite(b.seed))) {
    return { error: "`seed` must be a finite number" };
  }
  for (const name of ["width", "height"] as const) {
    const err = dimensionError(name, b[name]);
    if (err) return { error: err };
  }
  if (b.references !== undefined) {
    if (
      !Array.isArray(b.references) ||
      b.references.length > 4 ||
      !b.references.every((r) => typeof r === "string" && r.length > 0)
    ) {
      return { error: "`references` must be an array of up to 4 non-empty base64 strings" };
    }
  }
  if (
    b.referenceStrength !== undefined &&
    (typeof b.referenceStrength !== "number" ||
      !Number.isFinite(b.referenceStrength) ||
      b.referenceStrength <= 0 ||
      b.referenceStrength > 1.5)
  ) {
    return { error: "`referenceStrength` must be a number in (0, 1.5]" };
  }
  // Half the schedule is the practical ceiling: past that there is too little signal left for the
  // adapter to establish a likeness at all.
  if (
    b.referenceStart !== undefined &&
    (typeof b.referenceStart !== "number" ||
      !Number.isFinite(b.referenceStart) ||
      b.referenceStart < 0 ||
      b.referenceStart > 0.5)
  ) {
    return { error: "`referenceStart` must be a number in [0, 0.5]" };
  }
  if (b.initImage !== undefined && (typeof b.initImage !== "string" || b.initImage === "")) {
    return { error: "`initImage` must be a non-empty base64 PNG string" };
  }
  if (
    b.denoise !== undefined &&
    (typeof b.denoise !== "number" ||
      !Number.isFinite(b.denoise) ||
      b.denoise <= 0 ||
      b.denoise > 1)
  ) {
    return { error: "`denoise` must be a number in (0, 1]" };
  }
  if (
    b.upscale !== undefined &&
    (typeof b.upscale !== "number" || !Number.isFinite(b.upscale) || b.upscale <= 1 || b.upscale > 4)
  ) {
    return { error: "`upscale` must be a number in (1, 4]" };
  }
  if (b.upscaleModel !== undefined) {
    const err = modelNameError("upscaleModel", b.upscaleModel);
    if (err) return { error: err };
  }

  const params: GenerateParams = { prompt: b.prompt };
  if (typeof b.negativePrompt === "string") params.negativePrompt = b.negativePrompt;
  if (typeof b.style === "string") params.style = b.style;
  if (b.quality !== undefined) params.quality = b.quality as Quality;
  if (typeof b.seed === "number") params.seed = b.seed;
  if (typeof b.width === "number") params.width = b.width;
  if (typeof b.height === "number") params.height = b.height;
  if (Array.isArray(b.references) && b.references.length) {
    params.references = b.references as string[];
  }
  if (typeof b.referenceStrength === "number") params.referenceStrength = b.referenceStrength;
  if (typeof b.checkpoint === "string") params.checkpoint = b.checkpoint.trim();
  if (typeof b.referenceStart === "number") params.referenceStart = b.referenceStart;
  if (typeof b.initImage === "string" && b.initImage !== "") params.initImage = b.initImage;
  if (typeof b.denoise === "number") params.denoise = b.denoise;
  if (typeof b.upscale === "number") params.upscale = b.upscale;
  if (typeof b.upscaleModel === "string") params.upscaleModel = b.upscaleModel.trim();
  return { params };
}

// Validate + normalize the /animate body (ADR-0009). `image` + `prompt` are required; the rest are
// optional and default per ADR-0008. Boundaries are lenient — the engine (renderWanWorkflow) owns the
// multiple-of-32 / 4k+1 grid snapping, so this only rejects the out-of-range and wrong-type cases.
function parseAnimateBody(raw: string): { params: AnimateParams } | { error: string } {
  let body: unknown;
  try {
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { error: "request body is not valid JSON" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "request body must be a JSON object" };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.prompt !== "string" || b.prompt.trim() === "") {
    return { error: "`prompt` is required and must be a non-empty string" };
  }
  if (typeof b.image !== "string" || b.image === "") {
    return { error: "`image` is required and must be a non-empty base64 string" };
  }
  if (b.negativePrompt !== undefined && typeof b.negativePrompt !== "string") {
    return { error: "`negativePrompt` must be a string" };
  }
  if (b.seed !== undefined && (typeof b.seed !== "number" || !Number.isFinite(b.seed))) {
    return { error: "`seed` must be a finite number" };
  }
  for (const name of ["width", "height"] as const) {
    const err = videoDimensionError(name, b[name]);
    if (err) return { error: err };
  }
  if (
    b.frames !== undefined &&
    (typeof b.frames !== "number" || !Number.isInteger(b.frames) || b.frames < 1 || b.frames > MAX_FRAMES)
  ) {
    return { error: `\`frames\` must be an integer in [1, ${MAX_FRAMES}]` };
  }
  if (
    b.fps !== undefined &&
    (typeof b.fps !== "number" || !Number.isFinite(b.fps) || b.fps < 1 || b.fps > MAX_FPS)
  ) {
    return { error: `\`fps\` must be a number in [1, ${MAX_FPS}]` };
  }
  if (b.model !== undefined && !isAnimateModel(b.model)) {
    return { error: `\`model\` must be one of: ${ANIMATE_MODELS.join(", ")}` };
  }

  const params: AnimateParams = { prompt: b.prompt, image: b.image };
  if (typeof b.negativePrompt === "string") params.negativePrompt = b.negativePrompt;
  if (typeof b.seed === "number") params.seed = b.seed;
  if (typeof b.width === "number") params.width = b.width;
  if (typeof b.height === "number") params.height = b.height;
  if (typeof b.frames === "number") params.frames = b.frames;
  if (typeof b.fps === "number") params.fps = b.fps;
  if (isAnimateModel(b.model)) params.model = b.model;
  return { params };
}

// Validate the /stitch body (ADR-0010): a `clips` array of 2–50 non-empty base64 mp4 strings, in the
// order they should be joined. Returns the clip strings or a 422 message.
function parseStitchBody(raw: string): { clips: string[] } | { error: string } {
  let body: unknown;
  try {
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { error: "request body is not valid JSON" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { error: "request body must be a JSON object" };
  }
  const clips = (body as Record<string, unknown>).clips;
  if (!Array.isArray(clips)) {
    return { error: "`clips` is required and must be an array of base64 mp4 strings" };
  }
  if (clips.length < 2) {
    return { error: "`clips` must contain at least 2 clips to stitch" };
  }
  if (clips.length > MAX_CLIPS) {
    return { error: `\`clips\` must contain at most ${MAX_CLIPS} clips` };
  }
  if (!clips.every((c) => typeof c === "string" && c.length > 0)) {
    return { error: "each entry in `clips` must be a non-empty base64 string" };
  }
  return { clips: clips as string[] };
}

// A checkpoint override is a ComfyUI ckpt_name (may include a forward-slash subfolder). We keep
// validation light — ComfyUI is the authority on which names exist — but reject the obviously
// unsafe/empty shapes: non-strings, empty/whitespace, overlong, path traversal, backslashes, NUL,
// or an absolute path. Returns an error string for a 422, or null when valid.
const MAX_CHECKPOINT_LEN = 200;
function checkpointError(value: unknown): string | null {
  if (typeof value !== "string") return "`checkpoint` must be a string";
  const v = value.trim();
  if (v === "") return "`checkpoint` must be a non-empty string";
  if (v.length > MAX_CHECKPOINT_LEN) {
    return `\`checkpoint\` must be at most ${MAX_CHECKPOINT_LEN} characters`;
  }
  if (v.includes("..") || v.includes("\\") || v.includes("\0") || v.startsWith("/")) {
    return "`checkpoint` contains an invalid path";
  }
  return null;
}

// Same light path-safety as checkpointError, for any model-name field (e.g. `upscaleModel`).
function modelNameError(field: string, value: unknown): string | null {
  if (typeof value !== "string") return `\`${field}\` must be a string`;
  const v = value.trim();
  if (v === "") return `\`${field}\` must be a non-empty string`;
  if (v.length > MAX_CHECKPOINT_LEN) {
    return `\`${field}\` must be at most ${MAX_CHECKPOINT_LEN} characters`;
  }
  if (v.includes("..") || v.includes("\\") || v.includes("\0") || v.startsWith("/")) {
    return `\`${field}\` contains an invalid path`;
  }
  return null;
}

// SDXL latent dimensions must be positive multiples of 8 within a sane range. Returns an error
// string for a 422, or null when the value is absent (default kept) or valid.
const MIN_DIMENSION = 256;
const MAX_DIMENSION = 2048;
function dimensionError(name: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_DIMENSION ||
    value > MAX_DIMENSION ||
    value % 8 !== 0
  ) {
    return `\`${name}\` must be an integer multiple of 8 in [${MIN_DIMENSION}, ${MAX_DIMENSION}]`;
  }
  return null;
}

// Video (Wan) dimensions: a positive integer in a sane range. Unlike SDXL's multiple-of-8 rule, the
// engine snaps these to Wan's multiple-of-32 grid, so the boundary check stays lenient. Returns an
// error string for a 422, or null when absent (default kept) or valid.
function videoDimensionError(name: string, value: unknown): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_DIMENSION ||
    value > MAX_DIMENSION
  ) {
    return `\`${name}\` must be an integer in [${MIN_DIMENSION}, ${MAX_DIMENSION}]`;
  }
  return null;
}

// Constant-time string compare that never throws and is safe for unequal lengths.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Optional shared-token gate (ADR-0002). Open when auth is disabled (the LAN default). When
// enabled, requires `Authorization: Bearer <token>` matching config.auth.token. Fails closed if
// auth is enabled but no token is configured. Callers get a bare 401 — this never reveals whether
// a token is required, missing, or merely wrong.
function isAuthorized(req: IncomingMessage, config: Config): boolean {
  if (!config.auth.enabled) return true;
  const configured = config.auth.token;
  if (configured === "") return false; // misconfiguration → deny everything
  const header = req.headers["authorization"] ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return safeEqual(header.slice(prefix.length), configured);
}

async function handleGenerate(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  fetchFn: FetchFn,
  lease: GpuLease,
): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 422, { error: "could not read request body" });
    return;
  }
  const parsed = parseGenerateBody(raw);
  if ("error" in parsed) {
    sendJson(res, 422, { error: parsed.error });
    return;
  }
  // Resolve the checkpoint (precedence: request > config > workflow-template default). A friendly
  // catalog name (e.g. "dreamshaper") maps to its ComfyUI filename; a raw filename passes through.
  parsed.params.checkpoint = resolveCheckpoint(parsed.params.checkpoint || config.comfyui.checkpoint);
  // Same for the upscale model when an upscale was requested without naming one (the engine falls
  // back to the first installed model if this is still empty).
  if (parsed.params.upscale && !parsed.params.upscaleModel && config.comfyui.upscaleModel) {
    parsed.params.upscaleModel = config.comfyui.upscaleModel;
  }
  // Run inside the shared GPU lease: hold the flock while busy, free ComfyUI + release once the batch
  // drains (ADR-0012). The lease sits around the whole engine call; the per-request prompt_id
  // isolation inside the engine is unchanged.
  const result = await lease.run(() => generateImage(config.comfyui.url, parsed.params, fetchFn));
  if (result.ok) {
    sendPng(res, result.bytes);
  } else {
    // All engine failures are ComfyUI-side (unreachable / timeout / rejected workflow).
    sendJson(res, 503, { error: result.error });
  }
}

async function handleAnimate(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  fetchFn: FetchFn,
  lease: GpuLease,
): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 422, { error: "could not read request body" });
    return;
  }
  const parsed = parseAnimateBody(raw);
  if ("error" in parsed) {
    sendJson(res, 422, { error: parsed.error });
    return;
  }
  // Same shared GPU lease as /generate. A long Wan render legitimately holds the whole time; maxHoldMs
  // is sized above ANIMATE_TIMEOUT_MS so it never self-yields mid-video (ADR-0012).
  const result = await lease.run(() => animateImage(config.comfyui.url, parsed.params, fetchFn));
  if (result.ok) {
    sendBytes(res, result.bytes, result.contentType);
  } else {
    // All engine failures are ComfyUI-side (unreachable / missing Wan models / timeout / rejected).
    sendJson(res, 503, { error: result.error });
  }
}

async function handleStitch(
  req: IncomingMessage,
  res: ServerResponse,
  stitch: (clips: Buffer[]) => Promise<StitchResult>,
): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req, MAX_STITCH_BODY_BYTES);
  } catch (err) {
    const tooLarge = err instanceof Error && /too large/.test(err.message);
    sendJson(res, tooLarge ? 413 : 422, {
      error: tooLarge
        ? `request body exceeds ${Math.round(MAX_STITCH_BODY_BYTES / 1_000_000)} MB — stitch fewer or shorter clips`
        : "could not read request body",
    });
    return;
  }
  const parsed = parseStitchBody(raw);
  if ("error" in parsed) {
    sendJson(res, 422, { error: parsed.error });
    return;
  }
  const clips = parsed.clips.map((b64) => Buffer.from(b64, "base64"));
  const result = await stitch(clips);
  if (result.ok) {
    sendBytes(res, result.bytes, "video/mp4");
  } else {
    // ffmpeg missing / concat failure — a host-side problem, like the ComfyUI 503s.
    sendJson(res, 503, { error: result.error });
  }
}

function handleStyles(res: ServerResponse): void {
  const styles = Object.entries(STYLE_LORAS).map(([name, recipe]) => ({
    name,
    hasLora: true,
    trigger: recipe.trigger,
    strength: recipe.strength,
    loraFile: recipe.loraFile,
  }));
  sendJson(res, 200, {
    styles,
    note: "Styles not listed here are accepted by /generate and rendered prompt-only (no LoRA).",
  });
}

// GET /checkpoints — the curated SFW checkpoint catalog, each flagged with whether its file is
// actually installed on the fronted ComfyUI. probeComfy never throws (empty lists on failure), so
// `installed` degrades to false rather than erroring.
async function handleCheckpoints(res: ServerResponse, config: Config, fetchFn: FetchFn): Promise<void> {
  const { checkpoints: installed } = await probeComfy(config.comfyui.url, fetchFn);
  const checkpoints = Object.entries(CHECKPOINTS).map(([name, info]) => ({
    name,
    file: info.file,
    description: info.description,
    installed: installed.includes(info.file),
  }));
  sendJson(res, 200, {
    checkpoints,
    note: "Any checkpoint installed in ComfyUI's models/checkpoints/ also works by exact filename via the `checkpoint` field on /generate.",
  });
}

async function handleHealth(
  res: ServerResponse,
  config: Config,
  fetchFn: FetchFn,
  ffmpegCheck: () => Promise<boolean>,
): Promise<void> {
  const { reachable, loras, checkpoints, upscaleModels } = await probeComfy(config.comfyui.url, fetchFn);
  // Report which recipe LoRAs are actually present on the GPU host.
  const recipeFiles = Array.from(new Set(Object.values(STYLE_LORAS).map((r) => r.loraFile)));
  const lorasLoaded = recipeFiles.filter((f) => loras.includes(f));
  // Same for the curated checkpoint catalog: which of its files are actually installed.
  const catalogCheckpoints = Array.from(new Set(Object.values(CHECKPOINTS).map((c) => c.file)));
  const checkpointsInstalled = catalogCheckpoints.filter((f) => checkpoints.includes(f));
  // The effective default checkpoint (config override, else the workflow template's), plus the full
  // list ComfyUI can load so a client can offer a picker.
  const checkpoint = config.comfyui.checkpoint || DEFAULT_CHECKPOINT;
  // Effective default upscale model (config override, else the first installed) + the full list.
  const upscaleModel = config.comfyui.upscaleModel || upscaleModels[0] || "";
  // Image-to-video readiness (ADR-0009): which of the three Wan 2.2 files are present. Best-effort —
  // when ComfyUI is unreachable all three read as missing and `ready` is false. Skipped entirely when
  // unreachable to avoid three doomed probes.
  const wanMissing = reachable ? await wanModelsMissing(config.comfyui.url, fetchFn) : ["comfyui-unreachable"];
  // Video stitching availability (ADR-0010): whether ffmpeg is on the host. Independent of ComfyUI.
  const stitchAvailable = await ffmpegCheck();
  sendJson(res, 200, {
    comfyuiReachable: reachable,
    comfyuiUrl: config.comfyui.url,
    lorasLoaded,
    checkpoint,
    checkpoints,
    checkpointsInstalled,
    upscaleModel,
    upscaleModels,
    wan: { ready: wanMissing.length === 0, missing: wanMissing },
    stitch: { available: stitchAvailable },
  });
}

export function createServer(config: Config, fetchFn: FetchFn = fetch, deps: ServerDeps = {}): Server {
  const stitch = deps.stitchVideos ?? stitchVideosDefault;
  const ffmpegCheck = deps.ffmpegAvailable ?? (() => ffmpegAvailableDefault());
  // The single process-wide GPU lease shared by every /generate and /animate request (ADR-0012).
  // Defensive on config.gpuLock: a partial test Config without the block reads as disabled (bypass).
  const gpuLock = config.gpuLock;
  const lease = new GpuLease({
    enabled: gpuLock?.enabled === true,
    path: gpuLock?.path ?? "/var/lock/gpu-tenant.lock",
    maxHoldMs: gpuLock?.maxHoldMs ?? 1_260_000,
    idleGraceMs: gpuLock?.idleGraceMs ?? 5_000,
    acquireTimeoutMs: gpuLock?.acquireTimeoutMs ?? 120_000,
    comfyUrl: config.comfyui.url,
    fetchFn,
    provider: deps.lockProvider,
  });
  return createHttpServer((req, res) => {
    // Top-level guard: nothing below may throw out of the handler.
    void (async () => {
      try {
        const method = req.method ?? "GET";
        const url = (req.url ?? "/").split("?")[0];

        // Built-in dev/test UI — served ungated so the page always loads and a token can be
        // entered into it. Its own fetches to /styles and /generate carry that token.
        if (method === "GET" && (url === "/" || url === "/index.html")) {
          sendHtml(res, UI_HTML);
          return;
        }
        if (method === "POST" && url === "/generate") {
          if (!isAuthorized(req, config)) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          await handleGenerate(req, res, config, fetchFn, lease);
          return;
        }
        if (method === "POST" && url === "/animate") {
          if (!isAuthorized(req, config)) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          await handleAnimate(req, res, config, fetchFn, lease);
          return;
        }
        if (method === "POST" && url === "/stitch") {
          if (!isAuthorized(req, config)) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          await handleStitch(req, res, stitch);
          return;
        }
        if (method === "GET" && url === "/styles") {
          if (!isAuthorized(req, config)) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          handleStyles(res);
          return;
        }
        if (method === "GET" && url === "/checkpoints") {
          if (!isAuthorized(req, config)) {
            sendJson(res, 401, { error: "unauthorized" });
            return;
          }
          await handleCheckpoints(res, config, fetchFn);
          return;
        }
        // /health is intentionally NEVER gated — monitoring must work without the token.
        if (method === "GET" && url === "/health") {
          await handleHealth(res, config, fetchFn, ffmpegCheck);
          return;
        }
        sendJson(res, 404, { error: `no route for ${method} ${url}` });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[server] unhandled error: ${reason}`);
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
        else res.end();
      }
    })();
  });
}
