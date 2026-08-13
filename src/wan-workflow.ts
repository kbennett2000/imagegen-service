// Wan 2.2 TI2V 5B image-to-video workflow renderer (ADR-0008). Mirrors the SDXL engine's convention:
// a template JSON is stored alongside the SDXL templates and mutated BY NODE ID on a fresh clone per
// call — so there is no shared mutable state and rendering is a pure function of its params.
//
// This cycle wires nothing into an endpoint; the smoke script (scripts/smoke-wan22.ts) submits the
// rendered graph directly to ComfyUI. A future /animate endpoint reuses renderWanWorkflow verbatim.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "workflows");
export const WAN_WORKFLOW = "wan22-ti2v-5b-i2v.json";

// The three model files this workflow requires ComfyUI to have loaded (ADR-0008). Kept here so the
// smoke script can assert their presence via /object_info and fail loudly, and so a future endpoint
// can reuse the list.
export const WAN_DIFFUSION_MODEL = "wan2.2_ti2v_5B_fp16.safetensors";
export const WAN_TEXT_ENCODER = "umt5_xxl_fp8_e4m3fn_scaled.safetensors";
export const WAN_VAE = "wan2.2_vae.safetensors";

// Defaults (ADR-0008): 1280x704 is the 5B's native training resolution, 24 fps, and frame count is
// capped at 121 (5 seconds).
export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 704;
export const DEFAULT_FPS = 24;
export const DEFAULT_FRAMES = 121;
export const MAX_FRAMES = 121;

export interface WanParams {
  prompt: string;
  // Appended to the template's baseline Wan negative prompt (mirrors the SDXL engine's negative
  // handling), never replacing it.
  negativePrompt?: string;
  seed?: number;
  width?: number;
  height?: number;
  // Frame count. Snapped to Wan's valid 4k+1 grid and capped at MAX_FRAMES.
  frames?: number;
  fps?: number;
  // The filename ComfyUI returned from /upload/image for the input still (LoadImage.image).
  imageName: string;
}

type GraphNode = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, GraphNode>;

// Fetch a node the template is expected to contain. The template ships in-repo, so a missing id is a
// template bug, not a runtime input error — throw rather than silently no-op (unlike the SDXL engine's
// setNode* helpers, which tolerate absent ids because they run against two different-shaped graphs).
function node(graph: Graph, id: string): GraphNode {
  const n = graph[id];
  if (!n) throw new Error(`wan workflow template is missing node "${id}"`);
  return n;
}

// Snap a requested pixel dimension to the node's multiple-of-32 grid, with a sane floor. Wan's
// latent/scale nodes step by 32; an off-grid value is rejected by ComfyUI otherwise.
export function normalizeDimension(value: number | undefined, fallback: number): number {
  const v = Number.isFinite(value) ? (value as number) : fallback;
  const snapped = Math.round(v / 32) * 32;
  return Math.max(32, snapped);
}

// Snap a requested frame count to Wan's valid length grid (4k+1: 1, 5, 9, ... 121) and cap it at
// MAX_FRAMES. The temporal VAE compresses by 4, so only 4k+1 lengths are valid.
export function normalizeFrames(value: number | undefined): number {
  const v = Number.isFinite(value) ? (value as number) : DEFAULT_FRAMES;
  const capped = Math.min(MAX_FRAMES, Math.max(1, Math.floor(v)));
  // Round to the nearest 4k+1 at or below the cap.
  const k = Math.round((capped - 1) / 4);
  const grid = Math.min(MAX_FRAMES, k * 4 + 1);
  return Math.max(1, grid);
}

// Render the Wan i2v graph: read the template, clone it, and inject params by node id. Pure — never
// mutates a shared object, so concurrent callers are safe (same guarantee as the SDXL engine).
export function renderWanWorkflow(params: WanParams): Graph {
  const graph = JSON.parse(readFileSync(path.join(WORKFLOWS_DIR, WAN_WORKFLOW), "utf8")) as Graph;

  const width = normalizeDimension(params.width, DEFAULT_WIDTH);
  const height = normalizeDimension(params.height, DEFAULT_HEIGHT);
  const length = normalizeFrames(params.frames);
  const fps = Number.isFinite(params.fps) ? (params.fps as number) : DEFAULT_FPS;
  const seed = Number.isFinite(params.seed) ? (params.seed as number) : randomSeed();

  // Positive prompt.
  node(graph, "6").inputs.text = params.prompt;
  // Baseline Wan negative lives in the template; append the caller's (never replace it).
  if (params.negativePrompt) {
    const neg = node(graph, "7");
    neg.inputs.text = `${neg.inputs.text}, ${params.negativePrompt}`;
  }
  // Target resolution — set on BOTH the explicit scaler and the latent builder so they agree.
  const scaler = node(graph, "53");
  const latent = node(graph, "55");
  scaler.inputs.width = width;
  scaler.inputs.height = height;
  latent.inputs.width = width;
  latent.inputs.height = height;
  latent.inputs.length = length;
  // Frame rate, seed, and the uploaded input image.
  node(graph, "57").inputs.fps = fps;
  node(graph, "3").inputs.seed = seed;
  node(graph, "52").inputs.image = params.imageName;

  return graph;
}

function randomSeed(): number {
  // Runtime helper (not a workflow script) — Math.random is fine here, matching src/engine.ts.
  return Math.floor(Math.random() * 0x1_0000_0000);
}
