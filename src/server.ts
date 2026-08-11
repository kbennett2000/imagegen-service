// HTTP layer: Node built-in http server, no web framework. Three routes — POST /generate,
// GET /styles, GET /health. Handlers NEVER throw and NEVER leak a stack: every failure returns
// a JSON error body with an appropriate status.

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { Config } from "./config.js";
import {
  generateImage,
  probeComfy,
  QUALITIES,
  type FetchFn,
  type GenerateParams,
  type Quality,
} from "./engine.js";
import { STYLE_LORAS } from "./style-loras.js";

// Generous cap. Raised from 1 MB to accommodate base64 reference images (a 1024² portrait PNG is
// ~1.5 MB raw → ~2 MB base64); a few references still fit comfortably.
const MAX_BODY_BYTES = 16_000_000;

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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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
  return { params };
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
  const result = await generateImage(config.comfyui.url, parsed.params, fetchFn);
  if (result.ok) {
    sendPng(res, result.bytes);
  } else {
    // All engine failures are ComfyUI-side (unreachable / timeout / rejected workflow).
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

async function handleHealth(res: ServerResponse, config: Config, fetchFn: FetchFn): Promise<void> {
  const { reachable, loras } = await probeComfy(config.comfyui.url, fetchFn);
  // Report which recipe LoRAs are actually present on the GPU host.
  const recipeFiles = Array.from(new Set(Object.values(STYLE_LORAS).map((r) => r.loraFile)));
  const lorasLoaded = recipeFiles.filter((f) => loras.includes(f));
  sendJson(res, 200, {
    comfyuiReachable: reachable,
    comfyuiUrl: config.comfyui.url,
    lorasLoaded,
  });
}

export function createServer(config: Config, fetchFn: FetchFn = fetch): Server {
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
          await handleGenerate(req, res, config, fetchFn);
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
        // /health is intentionally NEVER gated — monitoring must work without the token.
        if (method === "GET" && url === "/health") {
          await handleHealth(res, config, fetchFn);
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
