// Wan text-to-video workflow renderer (ADR-0022, Phase 2). A THIRD architecture path: no input image
// and no CLIP-vision — just prompt → EmptyHunyuanLatentVideo → sampler. Covers 16-channel Wan 2.1/2.2
// T2V models (incl. GGUF/fp8 quantized). Shares the 16-ch wan_2.1_vae + umt5 text encoder with the
// Wan 2.1 i2v path. Pure: mutates a fresh clone per call. The diffusion model is injected by the
// engine (loader by file format), so no model name is baked in (ADR-0021).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "workflows");
export const WAN_T2V_WORKFLOW = "wan-t2v.json";

// Shared infra (content-neutral): umt5 text encoder + 16-ch VAE. No CLIP-vision (no input image).
export const WAN_T2V_TEXT_ENCODER = "umt5_xxl_fp8_e4m3fn_scaled.safetensors";
export const WAN_T2V_VAE = "wan_2.1_vae.safetensors";

export const WAN_T2V_DEFAULT_WIDTH = 832;
export const WAN_T2V_DEFAULT_HEIGHT = 480;
export const WAN_T2V_DEFAULT_FPS = 16;
export const WAN_T2V_DEFAULT_FRAMES = 81;
export const WAN_T2V_MAX_FRAMES = 81;
export const WAN_T2V_DEFAULT_STEPS = 20;
export const WAN_T2V_DEFAULT_CFG = 6.0;

export interface WanT2vParams {
  prompt: string;
  negativePrompt?: string;
  seed?: number;
  width?: number;
  height?: number;
  frames?: number;
  fps?: number;
  steps?: number;
  cfg?: number;
}

type GraphNode = { class_type: string; inputs: Record<string, unknown> };
type Graph = Record<string, GraphNode>;

function node(graph: Graph, id: string): GraphNode {
  const n = graph[id];
  if (!n) throw new Error(`wan t2v workflow template is missing node "${id}"`);
  return n;
}

function dim16(value: number | undefined, fallback: number): number {
  const v = Number.isFinite(value) ? (value as number) : fallback;
  return Math.max(16, Math.round(v / 16) * 16);
}

function frames4k1(value: number | undefined): number {
  const v = Number.isFinite(value) ? (value as number) : WAN_T2V_DEFAULT_FRAMES;
  const capped = Math.min(WAN_T2V_MAX_FRAMES, Math.max(1, Math.floor(v)));
  const k = Math.round((capped - 1) / 4);
  return Math.max(1, Math.min(WAN_T2V_MAX_FRAMES, k * 4 + 1));
}

export function renderWanT2vWorkflow(params: WanT2vParams): Graph {
  const graph = JSON.parse(readFileSync(path.join(WORKFLOWS_DIR, WAN_T2V_WORKFLOW), "utf8")) as Graph;

  const width = dim16(params.width, WAN_T2V_DEFAULT_WIDTH);
  const height = dim16(params.height, WAN_T2V_DEFAULT_HEIGHT);
  const length = frames4k1(params.frames);
  const fps = Number.isFinite(params.fps) ? (params.fps as number) : WAN_T2V_DEFAULT_FPS;
  const seed = Number.isFinite(params.seed) ? (params.seed as number) : Math.floor(Math.random() * 0x1_0000_0000);
  const steps = Number.isFinite(params.steps) ? Math.max(1, Math.floor(params.steps as number)) : WAN_T2V_DEFAULT_STEPS;
  const cfg = Number.isFinite(params.cfg) ? (params.cfg as number) : WAN_T2V_DEFAULT_CFG;

  node(graph, "6").inputs.text = params.prompt;
  if (params.negativePrompt) {
    const neg = node(graph, "7");
    neg.inputs.text = `${neg.inputs.text}, ${params.negativePrompt}`;
  }
  const latent = node(graph, "55");
  latent.inputs.width = width;
  latent.inputs.height = height;
  latent.inputs.length = length;
  node(graph, "57").inputs.fps = fps;
  const sampler = node(graph, "3");
  sampler.inputs.seed = seed;
  sampler.inputs.steps = steps;
  sampler.inputs.cfg = cfg;

  return graph;
}
