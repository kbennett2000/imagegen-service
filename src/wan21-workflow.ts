// Wan 2.1 image-to-video workflow renderer (ADR-0022, Phase 1). Parallels wan-workflow.ts (the Wan
// 2.2 TI2V 5B path) but drives the Wan 2.1 I2V pipeline, which is a DIFFERENT architecture: a 16-ch
// VAE (wan_2.1_vae), a CLIP-vision encoder feeding WanImageToVideo, and image conditioning built by
// that node (not Wan22ImageToVideoLatent). The diffusion model itself is injected by the engine
// (loader chosen by file format), so no model name is baked in here (ADR-0021). Pure: mutates a fresh
// clone of the template per call.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "workflows");
export const WAN21_I2V_WORKFLOW = "wan21-i2v.json";

// Shared Wan infra this pipeline needs installed (content-neutral). The diffusion model is discovered
// (ADR-0021); these are wired into the template and reconciled by the engine (ADR-0020).
export const WAN21_TEXT_ENCODER = "umt5_xxl_fp8_e4m3fn_scaled.safetensors";
export const WAN21_VAE = "wan_2.1_vae.safetensors";
export const WAN21_CLIP_VISION = "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors";

// Defaults (Wan 2.1 I2V): 832x480 is the 480p native resolution, 16 fps, up to 81 frames (~5s). The
// non-distilled defaults are 20 steps / cfg 6; distilled models (e.g. lightx2v 4-step) override via
// params.steps / params.cfg.
export const WAN21_DEFAULT_WIDTH = 832;
export const WAN21_DEFAULT_HEIGHT = 480;
export const WAN21_DEFAULT_FPS = 16;
export const WAN21_DEFAULT_FRAMES = 81;
export const WAN21_MAX_FRAMES = 81;
export const WAN21_DEFAULT_STEPS = 20;
export const WAN21_DEFAULT_CFG = 6.0;

export interface Wan21Params {
  prompt: string;
  negativePrompt?: string;
  seed?: number;
  width?: number;
  height?: number;
  frames?: number;
  fps?: number;
  // Sampler overrides — distilled i2v models (lightx2v, rapid) need low steps + cfg 1.
  steps?: number;
  cfg?: number;
  imageName: string;
}

type GraphNode = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, GraphNode>;

function node(graph: Graph, id: string): GraphNode {
  const n = graph[id];
  if (!n) throw new Error(`wan21 i2v workflow template is missing node "${id}"`);
  return n;
}

// Wan 2.1 spatial grid steps by 16.
export function normalizeDimension16(value: number | undefined, fallback: number): number {
  const v = Number.isFinite(value) ? (value as number) : fallback;
  const snapped = Math.round(v / 16) * 16;
  return Math.max(16, snapped);
}

// Snap frame count to the 4k+1 grid, capped at WAN21_MAX_FRAMES (temporal compression by 4).
export function normalizeFrames21(value: number | undefined): number {
  const v = Number.isFinite(value) ? (value as number) : WAN21_DEFAULT_FRAMES;
  const capped = Math.min(WAN21_MAX_FRAMES, Math.max(1, Math.floor(v)));
  const k = Math.round((capped - 1) / 4);
  return Math.max(1, Math.min(WAN21_MAX_FRAMES, k * 4 + 1));
}

export function renderWan21I2vWorkflow(params: Wan21Params): Graph {
  const graph = JSON.parse(readFileSync(path.join(WORKFLOWS_DIR, WAN21_I2V_WORKFLOW), "utf8")) as Graph;

  const width = normalizeDimension16(params.width, WAN21_DEFAULT_WIDTH);
  const height = normalizeDimension16(params.height, WAN21_DEFAULT_HEIGHT);
  const length = normalizeFrames21(params.frames);
  const fps = Number.isFinite(params.fps) ? (params.fps as number) : WAN21_DEFAULT_FPS;
  const seed = Number.isFinite(params.seed) ? (params.seed as number) : randomSeed();
  const steps = Number.isFinite(params.steps) ? Math.max(1, Math.floor(params.steps as number)) : WAN21_DEFAULT_STEPS;
  const cfg = Number.isFinite(params.cfg) ? (params.cfg as number) : WAN21_DEFAULT_CFG;

  node(graph, "6").inputs.text = params.prompt;
  if (params.negativePrompt) {
    const neg = node(graph, "7");
    neg.inputs.text = `${neg.inputs.text}, ${params.negativePrompt}`;
  }
  // Resolution on the image scaler + the i2v latent builder (they must agree).
  const scaler = node(graph, "53");
  const wiv = node(graph, "55");
  scaler.inputs.width = width;
  scaler.inputs.height = height;
  wiv.inputs.width = width;
  wiv.inputs.height = height;
  wiv.inputs.length = length;
  node(graph, "57").inputs.fps = fps;
  const sampler = node(graph, "3");
  sampler.inputs.seed = seed;
  sampler.inputs.steps = steps;
  sampler.inputs.cfg = cfg;
  node(graph, "52").inputs.image = params.imageName;

  return graph;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0x1_0000_0000);
}
