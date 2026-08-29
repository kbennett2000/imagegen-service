// Video model registry (ADR-0015). /animate was Wan-2.2-only; this table lets it dispatch across
// multiple image-to-video models by a `model` id, each contributing its own preflight file list and
// its own workflow renderer. animateImage (engine.ts) resolves the spec, preflights spec.files, and
// calls spec.render — the transport (upload -> POST /prompt -> poll -> /view) is shared.
//
// This module is pure data + renderers; it imports the per-model workflow renderers but NOT the
// engine, so there is no import cycle (engine.ts -> video-models.ts -> *-workflow.ts).

import { renderWanWorkflow, WAN_DIFFUSION_MODEL, WAN_TEXT_ENCODER, WAN_VAE } from "./wan-workflow.js";
import { renderLtxvWorkflow, LTXV_CHECKPOINT, LTXV_TEXT_ENCODER } from "./ltxv-workflow.js";

// Accepted /animate `model` ids. Add a model = extend this union and add its spec to VIDEO_MODELS.
export type AnimateModel = "wan-5b" | "ltxv";

// A ComfyUI API-format graph (flat {id: {class_type, inputs}}), same shape the SDXL/Wan renderers use.
export type VideoGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

// The params a renderer receives — identical across models; each renderer snaps/ignores what it must.
export interface VideoRenderParams {
  prompt: string;
  negativePrompt?: string;
  seed?: number;
  width?: number;
  height?: number;
  frames?: number;
  fps?: number;
  imageName: string; // the filename ComfyUI returned from /upload/image for the input still
}

// One model file the workflow needs ComfyUI to have loaded. `loaderClass`/`inputName` are the
// object_info node + combo the preflight probes; `subdir` only shapes the "what to fetch" message.
export interface VideoModelFile {
  loaderClass: string;
  inputName: string;
  file: string;
  subdir: string;
}

export interface VideoModelSpec {
  model: AnimateModel;
  label: string;
  files: readonly VideoModelFile[];
  // How to install this model's files, named in the "not installed" error so the user knows what to run.
  fetchHint: string;
  render: (params: VideoRenderParams) => VideoGraph;
}

// The Wan 2.2 TI2V 5B spec — the original /animate behavior, unchanged (ADR-0008/0009). Its three
// files and renderer are exactly what animateImage used before the registry existed.
const WAN_5B: VideoModelSpec = {
  model: "wan-5b",
  label: "Wan 2.2 TI2V 5B",
  files: [
    { loaderClass: "UNETLoader", inputName: "unet_name", file: WAN_DIFFUSION_MODEL, subdir: "diffusion_models" },
    { loaderClass: "CLIPLoader", inputName: "clip_name", file: WAN_TEXT_ENCODER, subdir: "text_encoders" },
    { loaderClass: "VAELoader", inputName: "vae_name", file: WAN_VAE, subdir: "vae" },
  ],
  fetchHint: "scripts/fetch-wan22-models.ts",
  render: renderWanWorkflow,
};

// LTX-Video (Lightricks) 2B — a faster, lighter alternative (ADR-0015). The v0.9.5 checkpoint bundles
// its VAE, so only two files: the checkpoint (models/checkpoints/) + the T5-XXL text encoder
// (models/text_encoders/). Both loaded via CheckpointLoaderSimple / CLIPLoader.
const LTXV: VideoModelSpec = {
  model: "ltxv",
  label: "LTX-Video 2B",
  files: [
    { loaderClass: "CheckpointLoaderSimple", inputName: "ckpt_name", file: LTXV_CHECKPOINT, subdir: "checkpoints" },
    { loaderClass: "CLIPLoader", inputName: "clip_name", file: LTXV_TEXT_ENCODER, subdir: "text_encoders" },
  ],
  fetchHint: "scripts/fetch-ltxv-models.ts",
  render: renderLtxvWorkflow,
};

// Registry keys are the accepted `model` ids. Add a model = add a spec here (+ its workflow template
// and fetch script). Keep DEFAULT_ANIMATE_MODEL as wan-5b so an /animate request without a `model`
// behaves exactly as before.
export const VIDEO_MODELS: Record<AnimateModel, VideoModelSpec> = {
  "wan-5b": WAN_5B,
  ltxv: LTXV,
};

export const ANIMATE_MODELS = Object.keys(VIDEO_MODELS) as AnimateModel[];
export const DEFAULT_ANIMATE_MODEL: AnimateModel = "wan-5b";

export function isAnimateModel(v: unknown): v is AnimateModel {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(VIDEO_MODELS, v);
}

// The spec for a model id, or the default spec when none is given. Callers validate the id first
// (server layer) so this is total for accepted ids.
export function getVideoModel(model?: AnimateModel | null): VideoModelSpec {
  return VIDEO_MODELS[model ?? DEFAULT_ANIMATE_MODEL] ?? VIDEO_MODELS[DEFAULT_ANIMATE_MODEL];
}
