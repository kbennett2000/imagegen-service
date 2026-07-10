// HTTP layer: Node built-in http server, no web framework. Three routes — POST /generate,
// GET /styles, GET /health. Handlers NEVER throw and NEVER leak a stack: every failure returns
// a JSON error body with an appropriate status.

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

const MAX_BODY_BYTES = 1_000_000; // generous cap for a small JSON body

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
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

  const params: GenerateParams = { prompt: b.prompt };
  if (typeof b.negativePrompt === "string") params.negativePrompt = b.negativePrompt;
  if (typeof b.style === "string") params.style = b.style;
  if (b.quality !== undefined) params.quality = b.quality as Quality;
  if (typeof b.seed === "number") params.seed = b.seed;
  return { params };
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

        if (method === "POST" && url === "/generate") {
          await handleGenerate(req, res, config, fetchFn);
          return;
        }
        if (method === "GET" && url === "/styles") {
          handleStyles(res);
          return;
        }
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
