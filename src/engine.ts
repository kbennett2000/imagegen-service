// The reusable engine, reimplemented from Chronicle's src/image-backends/local.ts (clean-room,
// no import). Responsibilities: quality tier -> workflow selection, style -> LoRA recipe
// injection (trigger + LoRA node + strength + noRefiner), and the ComfyUI transport
// (POST /prompt -> poll /history BY OWN prompt_id -> fetch /view). Never throws.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureTrigger, lookupStyleLora, type StyleLora } from "./style-loras.js";
import {
  getVideoModel,
  type AnimateModel,
  type VideoModelFile,
} from "./video-models.js";

// fetch is dependency-injected so tests drive the whole HTTP flow with no GPU / no ComfyUI.
export type FetchFn = typeof fetch;

export type Quality = "fast" | "standard" | "high";
export const QUALITIES: readonly Quality[] = ["fast", "standard", "high"];

export interface GenerateParams {
  prompt: string;
  negativePrompt?: string;
  style?: string;
  quality?: Quality;
  seed?: number;
  // Output dimensions for the EmptyLatentImage node. Omitted => the workflow's default (1024x1024).
  // The server validates these (positive multiple of 8, sane bounds) before they reach here.
  width?: number;
  height?: number;
  // Base checkpoint override (ComfyUI ckpt_name, e.g. "sd_xl_base_1.0.safetensors"). Omitted =>
  // the workflow template's own checkpoint. Applied to node "4" of both workflows (ADR-0004).
  checkpoint?: string;
  // Reference images (base64 PNGs) for IP-Adapter character-consistency conditioning. When present,
  // the engine uploads them to ComfyUI and injects an IP-Adapter apply node so the rendered subject
  // resembles the reference (a character's portrait). Absent => plain txt2img (unchanged).
  references?: string[];
  referenceStrength?: number; // IP-Adapter weight; default REFERENCE_WEIGHT.
  // Fraction of the denoising schedule to complete BEFORE identity is injected; default
  // REFERENCE_START. Raise it when the prompt's composition matters more than likeness (a
  // multi-figure scene); lower it for a single-subject plate. See ADR-0007.
  referenceStart?: number;
  // img2img: a base64 PNG used as the STARTING image (its pixels are the canvas), transformed toward
  // the prompt. Distinct from `references` (which conditions a fresh render on a likeness). When
  // present, the engine encodes it into the sampler's latent and lowers `denoise` (ADR-0005).
  initImage?: string;
  denoise?: number; // img2img strength in (0,1]; lower = closer to the input. Default DENOISE_DEFAULT.
  // Upscaling: when set, the finished image is enlarged by this factor (in (0,4]) with an ESRGAN-style
  // upscale model as a post-process. `upscaleModel` picks which model (else config default, else the
  // first installed one). No model installed => the request fails cleanly (ADR-0006).
  upscale?: number;
  upscaleModel?: string;
}

// IP-Adapter models (installed on the ComfyUI host) + tuned defaults. SDXL base + CLIP-ViT-H
// image encoder.
//
// ADR-0007: conditioning starts PART-WAY through the schedule, not at step 0. Injecting identity
// from the first step lets the reference dictate *composition* — the caller's downstream book
// shipped 84 plates that were near-copies of one two-figure reference painting, curtains and all.
// The early high-noise steps decide the layout and the figure count; they must belong to the text
// prompt alone. Identity lands afterwards, which is all a face adapter is for.
//
// The earlier mitigation for the same symptom was a lower `weight` (the note read "a bust portrait
// reference at higher weight collapses every scene into a bust"). That traded identity strength for
// composition and fixed neither; `startAt` separates the two concerns properly.
const IPADAPTER_FILE = "ip-adapter-plus-face_sdxl_vit-h.safetensors";
const CLIP_VISION_FILE = "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors";
const REFERENCE_WEIGHT = 0.5;
const REFERENCE_START = 0.3;
// `ip-adapter-plus-face` is trained on face crops. Fed a full bust it transfers the clothing and
// background too. PrepImageForClipVision(crop_position:"top") reduces the reference to its head
// before the CLIP-vision encode — the standard preparation for a face adapter.
const PREP_NODE = "PrepImageForClipVision";
// img2img default denoise: keeps the input's composition while letting the prompt substantially
// repaint it. Lower hews closer to the original; higher drifts toward pure txt2img.
const DENOISE_DEFAULT = 0.65;
// Extra wall-clock budget added to the tier timeout when upscaling — a 4× ESRGAN pass on a large
// plate is quick but not free.
const UPSCALE_TIMEOUT_BONUS_MS = 60_000;

export type GenerateResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; error: string };

// Image-to-video (ADR-0009). `image` is the base64 still to animate; the rest default per ADR-0008
// (1280x704, 24fps, 121 frames). Validated by the server before it reaches here.
export interface AnimateParams {
  prompt: string;
  image: string; // base64 still to animate (required)
  negativePrompt?: string;
  seed?: number;
  width?: number;
  height?: number;
  frames?: number;
  fps?: number;
  // Which video model to use (ADR-0015). Omitted => the default (wan-5b), so existing callers are
  // unaffected. The server validates this against ANIMATE_MODELS before it reaches here.
  model?: AnimateModel;
}

export type AnimateResult =
  | { ok: true; bytes: Buffer; contentType: string; filename: string }
  | { ok: false; error: string };

// A 121-frame 5B render takes minutes, and the FIRST animation after an image job also pays the
// one-time SDXL<->Wan model-load pause as the 12GB card swaps model sets (ADR-0008). Budget well
// above the image tiers' 2-5 min.
const ANIMATE_TIMEOUT_MS = 20 * 60_000;
// Downloading the finished mp4 (multi-MB) can exceed the 30s per-request budget the image path uses.
const VIEW_TIMEOUT_MS = 120_000;

const WORKFLOWS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "workflows");
const BASE_WORKFLOW = "sdxl-txt2img.json";
const REFINER_WORKFLOW = "sdxl-refiner.json";

// The checkpoint baked into the workflow templates (node "4"). Used only to report the effective
// checkpoint on /health when no override is configured; the actual render always reads the value
// from the template unless overridden. Keep in sync with the workflows' ckpt_name.
export const DEFAULT_CHECKPOINT = "sd_xl_base_1.0.safetensors";

const POLL_INTERVAL_MS = 500; // between /history polls
const REQUEST_TIMEOUT_MS = 30_000; // per individual HTTP request

// ---- tier selection (reused values) ------------------------------------------------------

export interface TierParams {
  workflow: string;
  steps?: number; // base-sampler step override; undefined => use the workflow's own schedule
  timeoutMs: number; // wall-clock budget for the history poll loop
}

export const TIER_CONFIG: Record<Quality, TierParams> = {
  fast: { workflow: BASE_WORKFLOW, steps: 15, timeoutMs: 120_000 },
  standard: { workflow: BASE_WORKFLOW, steps: 25, timeoutMs: 120_000 },
  high: { workflow: REFINER_WORKFLOW, timeoutMs: 300_000 },
};

export function resolveTier(quality?: Quality): TierParams {
  return TIER_CONFIG[quality ?? "standard"] ?? TIER_CONFIG.standard;
}

// The base chain is the only LoRA-wired chain. When a recipe is active and the resolved tier is
// the refiner (high), render base high-steps instead — keeping high's raised time budget. This
// is the noRefiner rule.
export function resolveEffectiveTier(quality: Quality | undefined, recipe: StyleLora): TierParams {
  const tier = resolveTier(quality);
  if (tier.workflow !== REFINER_WORKFLOW) return tier;
  if (!recipe.noRefiner) {
    console.error(
      `[engine] LoRA "${recipe.loraFile}" requested at quality=high, but refiner-aware LoRA injection isn't implemented — rendering base high-steps instead`,
    );
  }
  return { workflow: BASE_WORKFLOW, steps: 40, timeoutMs: tier.timeoutMs };
}

// ---- graph mutation helpers (reused) -----------------------------------------------------

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

function setNodeText(graph: Graph, id: string, text: string): void {
  const node = graph[id];
  if (node) node.inputs.text = text; // no-op if the node is absent
}

function appendNodeText(graph: Graph, id: string, extra: string): void {
  const node = graph[id];
  if (node) node.inputs.text = `${node.inputs.text}, ${extra}`;
}

function setNodeSeed(graph: Graph, id: string, seed: number): void {
  const node = graph[id];
  if (!node) return;
  if ("noise_seed" in node.inputs) node.inputs.noise_seed = seed; // KSamplerAdvanced (refiner)
  else node.inputs.seed = seed; // KSampler (base)
}

// Override the EmptyLatentImage output size. Each dimension is set only when the caller supplied
// it, so an omitted width/height keeps the workflow template's default (1024). No-op if absent.
function setNodeSize(graph: Graph, id: string, width?: number, height?: number): void {
  const node = graph[id];
  if (!node) return;
  if (width != null) node.inputs.width = width;
  if (height != null) node.inputs.height = height;
}

// Override a CheckpointLoaderSimple's ckpt_name. Applied to the base checkpoint node "4"; a set but
// unknown name is caught downstream by ComfyUI (node_errors -> a clean 503). No-op if the node is
// absent or no name was supplied (keeps the template's default).
function setNodeCheckpoint(graph: Graph, id: string, name?: string): void {
  const node = graph[id];
  if (!node || !name) return;
  node.inputs.ckpt_name = name;
}

// applyLora — copied exactly. Inject a LoraLoader as node "20" (an unused id in both templates)
// between the checkpoint (node "4") and its consumers, then repoint model/clip edges.
export function applyLora(graph: Graph, recipe: StyleLora): void {
  graph["20"] = {
    class_type: "LoraLoader",
    inputs: {
      lora_name: recipe.loraFile,
      strength_model: recipe.strength,
      strength_clip: recipe.strength,
      model: ["4", 0],
      clip: ["4", 1],
    },
  };
  if (graph["6"]) graph["6"].inputs.clip = ["20", 1]; // positive CLIP encode <- LoRA clip
  if (graph["7"]) graph["7"].inputs.clip = ["20", 1]; // negative CLIP encode <- LoRA clip
  if (graph["3"]) graph["3"].inputs.model = ["20", 0]; // sampler <- LoRA model
}

// applyIPAdapter — inject the IP-Adapter chain so the rendered subject resembles the reference
// image. Adds LoadImage(21) -> IPAdapterModelLoader(22) + CLIPVisionLoader(23) -> IPAdapterAdvanced(24),
// taking the model from the current source (the LoRA node "20" if present, else the checkpoint "4")
// and repointing the base sampler "3" to the IP-Adapter-modified model. Mirrors applyLora's style.
export function applyIPAdapter(
  graph: Graph,
  imageName: string,
  weight: number,
  startAt: number = REFERENCE_START,
  faceCrop: boolean = true,
): void {
  const modelSource: [string, number] = graph["20"] ? ["20", 0] : ["4", 0];
  graph["21"] = { class_type: "LoadImage", inputs: { image: imageName } };
  graph["22"] = {
    class_type: "IPAdapterModelLoader",
    inputs: { ipadapter_file: IPADAPTER_FILE },
  };
  graph["23"] = {
    class_type: "CLIPVisionLoader",
    inputs: { clip_name: CLIP_VISION_FILE },
  };
  // Optional head crop (node "25"), skipped when the host lacks PrepImageForClipVision so the
  // adapter still gets the raw reference rather than the render failing.
  let imageSource: [string, number] = ["21", 0];
  if (faceCrop) {
    graph["25"] = {
      class_type: PREP_NODE,
      inputs: {
        image: ["21", 0],
        interpolation: "LANCZOS",
        crop_position: "top",
        sharpening: 0.0,
      },
    };
    imageSource = ["25", 0];
  }
  graph["24"] = {
    class_type: "IPAdapterAdvanced",
    inputs: {
      model: modelSource,
      ipadapter: ["22", 0],
      image: imageSource,
      clip_vision: ["23", 0],
      weight,
      // "ease in-out" tapers the injection at both ends of its window, so identity blends in
      // rather than snapping on at `start_at` and leaving a seam.
      weight_type: "ease in-out",
      combine_embeds: "concat",
      start_at: startAt,
      end_at: 1.0,
      embeds_scaling: "V only",
    },
  };
  if (graph["3"]) graph["3"].inputs.model = ["24", 0]; // base sampler <- IP-Adapter-modified model
}

// applyImg2Img — make the request start from an input image instead of noise. Encodes the uploaded
// image to a latent (LoadImage(30) -> VAEEncode(31) using the workflow's VAELoader "10") and points
// the base sampler "3" at it, lowering `denoise` so the prompt repaints rather than replaces. Node
// ids 30/31 avoid the LoRA "20" / IP-Adapter "21"-"24" ranges, so img2img composes with both. The
// output size then follows the input image (EmptyLatentImage "5" is no longer the sampler's source).
export function applyImg2Img(graph: Graph, imageName: string, denoise: number): void {
  graph["30"] = { class_type: "LoadImage", inputs: { image: imageName } };
  graph["31"] = { class_type: "VAEEncode", inputs: { pixels: ["30", 0], vae: ["10", 0] } };
  if (graph["3"]) {
    graph["3"].inputs.latent_image = ["31", 0];
    graph["3"].inputs.denoise = denoise;
  }
}

// An upscale model's native factor, read from its filename (e.g. "4x-UltraSharp" or
// "RealESRGAN_x4plus" => 4). Defaults to 4 (the common ESRGAN factor) when unparseable.
export function parseUpscaleFactor(modelName: string): number {
  const m = modelName.match(/(\d+)\s*x/i) ?? modelName.match(/x\s*(\d+)/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 4;
}

// applyUpscale — enlarge the FINAL decoded image (node "8") with an ESRGAN-style model, then correct
// to the exact requested factor. UpscaleModelLoader(40) -> ImageUpscaleWithModel(41) runs the model
// at its native factor; ImageScaleBy(42) (relative, so it needs no absolute dims — works for img2img
// too) trims to `factor`. SaveImage "9" is repointed at the result. Runs last, after any img2img /
// LoRA / IP-Adapter mutation, so it composes with all of them. Ids 40-42 are otherwise unused.
export function applyUpscale(graph: Graph, modelName: string, factor: number): void {
  const native = parseUpscaleFactor(modelName);
  graph["40"] = { class_type: "UpscaleModelLoader", inputs: { model_name: modelName } };
  graph["41"] = {
    class_type: "ImageUpscaleWithModel",
    inputs: { upscale_model: ["40", 0], image: ["8", 0] },
  };
  let out: [string, number] = ["41", 0];
  if (Math.abs(factor - native) > 1e-6) {
    graph["42"] = {
      class_type: "ImageScaleBy",
      inputs: { upscale_method: "lanczos", scale_by: factor / native, image: ["41", 0] },
    };
    out = ["42", 0];
  }
  if (graph["9"]) graph["9"].inputs.images = out; // SaveImage <- upscaled image
}

// ---- ComfyUI transport helpers -----------------------------------------------------------

function comfyBase(url: string): string {
  return (url || "http://localhost:8188").replace(/\/$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomSeed(): number {
  // Service runtime (not a workflow script) — Math.random is fine here.
  return Math.floor(Math.random() * 0x1_0000_0000);
}

// Extract the option list from a ComfyUI combo input definition, tolerating both schemas ComfyUI
// emits: the legacy `[[...names...], {...}]` (names at [0]) and the newer
// `["COMBO", { options: [...names...] }]` (names under the trailing meta object's `options`). Some
// nodes (e.g. UpscaleModelLoader) use the new shape while others (CheckpointLoaderSimple, LoraLoader)
// still use the old one on the same server. Returns [] for anything unrecognized.
export function comboOptions(def: unknown): string[] {
  if (!Array.isArray(def)) return [];
  if (Array.isArray(def[0])) return def[0] as string[]; // legacy: names at [0]
  const meta = def[def.length - 1];
  if (meta && typeof meta === "object" && Array.isArray((meta as Record<string, unknown>).options)) {
    return (meta as Record<string, unknown>).options as string[];
  }
  return [];
}

// Read the option list of one combo input on one ComfyUI node class (e.g. LoraLoader.lora_name).
// The shared primitive behind every "what can ComfyUI load?" probe. Returns [] on any failure so a
// probe never throws into a request handler.
async function objectInfoOptions(
  base: string,
  fetchFn: FetchFn,
  cls: string,
  input: string,
): Promise<string[]> {
  try {
    const res = await fetchFn(`${base}/object_info/${cls}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const info = (await res.json().catch(() => ({}))) as Record<string, any>;
    return comboOptions(info?.[cls]?.input?.required?.[input]);
  } catch {
    return [];
  }
}

// Query ComfyUI's own filesystem for the LoRAs it can load. Used by /health and by the
// per-request availability check. Returns [] on any failure.
export async function listLoras(base: string, fetchFn: FetchFn): Promise<string[]> {
  return objectInfoOptions(base, fetchFn, "LoraLoader", "lora_name");
}

// Which of a video model's required files are NOT advertised by ComfyUI (ADR-0015). [] => all present
// and animation can run; a non-empty list is exactly what to fetch. Each file names the object_info
// loader + combo to probe; results keep the spec's file order. All files read missing when ComfyUI is
// unreachable (each probe returns []).
export async function videoModelsMissing(
  base: string,
  fetchFn: FetchFn,
  files: readonly VideoModelFile[],
): Promise<string[]> {
  const checks = await Promise.all(
    files.map(async (f) => ({
      f,
      present: (await objectInfoOptions(base, fetchFn, f.loaderClass, f.inputName)).includes(f.file),
    })),
  );
  return checks.filter((c) => !c.present).map((c) => `${c.f.subdir}/${c.f.file}`);
}

// The Wan 2.2 preflight, kept as a named export (used by the smoke path and tests). Delegates to the
// generic check with the wan-5b spec's file list.
export async function wanModelsMissing(base: string, fetchFn: FetchFn): Promise<string[]> {
  return videoModelsMissing(base, fetchFn, getVideoModel("wan-5b").files);
}

async function loraAvailable(base: string, fetchFn: FetchFn, loraFile: string): Promise<boolean> {
  const names = await listLoras(base, fetchFn);
  return names.includes(loraFile);
}

// Is the IP-Adapter model loaded on the ComfyUI host? (custom node + model must both be present.)
// Returns false on any error so the engine degrades to prompt-only rather than failing the render.
async function ipAdapterAvailable(base: string, fetchFn: FetchFn): Promise<boolean> {
  try {
    const res = await fetchFn(`${base}/object_info/IPAdapterModelLoader`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const info = (await res.json().catch(() => ({}))) as Record<string, any>;
    const files = comboOptions(info?.IPAdapterModelLoader?.input?.required?.ipadapter_file);
    return files.includes(IPADAPTER_FILE);
  } catch {
    return false;
  }
}

// Is a given custom node class installed on the ComfyUI host? Used for optional graph parts (the
// face crop) that must degrade rather than fail the render. False on any error.
async function nodeAvailable(base: string, fetchFn: FetchFn, classType: string): Promise<boolean> {
  try {
    const res = await fetchFn(`${base}/object_info/${classType}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const info = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return Boolean(info?.[classType]);
  } catch {
    return false;
  }
}

// Upload one base64 PNG to ComfyUI's input/ dir; returns the stored filename for a LoadImage node.
// A unique name per upload avoids clobbering when requests overlap. Used by both the IP-Adapter
// reference path and img2img. Throws on failure (the caller decides how to handle it).
async function uploadImage(base: string, fetchFn: FetchFn, b64: string): Promise<string> {
  const bytes = Buffer.from(b64, "base64");
  const filename = `img-${randomSeed().toString(16)}.png`;
  const form = new FormData();
  form.append("image", new Blob([bytes], { type: "image/png" }), filename);
  form.append("overwrite", "true");
  const res = await fetchFn(`${base}/upload/image`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ComfyUI /upload/image returned ${res.status}`);
  const j = (await res.json().catch(() => ({}))) as { name?: string };
  if (!j.name) throw new Error("ComfyUI /upload/image returned no name");
  return j.name;
}

// Health probe: is ComfyUI reachable, and does its /object_info respond? Returns the full list
// of LoRA names ComfyUI can load (empty when unreachable). Distinguishes reachability from an
// empty lora set via the `reachable` flag.
export async function probeComfy(
  comfyUrl: string,
  fetchFn: FetchFn = fetch,
): Promise<{ reachable: boolean; loras: string[]; checkpoints: string[]; upscaleModels: string[] }> {
  const base = comfyBase(comfyUrl);
  const empty = { reachable: false, loras: [], checkpoints: [], upscaleModels: [] };
  try {
    const res = await fetchFn(`${base}/object_info/LoraLoader`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return empty;
    const info = (await res.json().catch(() => ({}))) as Record<string, any>;
    const loras = comboOptions(info?.LoraLoader?.input?.required?.lora_name);
    // Reachability is established; the checkpoint/upscale lists are best-effort second probes that
    // must not fail /health if they error (return [] then).
    const [checkpoints, upscaleModels] = await Promise.all([
      listCheckpoints(base, fetchFn),
      listUpscaleModels(base, fetchFn),
    ]);
    return { reachable: true, loras, checkpoints, upscaleModels };
  } catch {
    return empty;
  }
}

// The checkpoints ComfyUI can load (CheckpointLoaderSimple.ckpt_name). Returns [] on any failure.
export async function listCheckpoints(base: string, fetchFn: FetchFn): Promise<string[]> {
  return objectInfoOptions(base, fetchFn, "CheckpointLoaderSimple", "ckpt_name");
}

// The upscale models ComfyUI can load (UpscaleModelLoader.model_name). Returns [] on any failure.
export async function listUpscaleModels(base: string, fetchFn: FetchFn): Promise<string[]> {
  return objectInfoOptions(base, fetchFn, "UpscaleModelLoader", "model_name");
}

interface OutImage {
  filename: string;
  subfolder: string;
  type: string;
}

// ---- main entry --------------------------------------------------------------------------

export async function generateImage(
  comfyUrl: string,
  params: GenerateParams,
  fetchFn: FetchFn = fetch,
): Promise<GenerateResult> {
  const base = comfyBase(comfyUrl);
  try {
    let positivePrompt = params.prompt;
    let tier = resolveTier(params.quality);

    // LoRA block — self-contained so it never taints the outer flow. Falls back to prompt-only
    // if the recipe's LoRA isn't actually loaded on the GPU host, or on any error.
    let recipe = lookupStyleLora(params.style);
    if (recipe) {
      try {
        tier = resolveEffectiveTier(params.quality, recipe);
        if (await loraAvailable(base, fetchFn, recipe.loraFile)) {
          positivePrompt = ensureTrigger(positivePrompt, recipe.trigger);
        } else {
          console.error(
            `[engine] LoRA "${recipe.loraFile}" not present on ComfyUI host — rendering prompt-only`,
          );
          recipe = undefined;
          tier = resolveTier(params.quality);
        }
      } catch {
        recipe = undefined;
        tier = resolveTier(params.quality);
      }
    }

    // IP-Adapter and img2img both need the base graph's node ids (VAELoader "10", sampler "3"); the
    // refiner graph has a different shape. Force base when either is present (like noRefiner).
    if ((params.references?.length || params.initImage) && tier.workflow === REFINER_WORKFLOW) {
      tier = { workflow: BASE_WORKFLOW, steps: 25, timeoutMs: tier.timeoutMs };
    }

    // Fresh graph clone per call — no shared mutable state (concurrency-critical).
    const graph = JSON.parse(
      readFileSync(path.join(WORKFLOWS_DIR, tier.workflow), "utf8"),
    ) as Graph;

    // Inject positive prompt (base + refiner positive nodes).
    for (const id of ["6", "12"]) setNodeText(graph, id, positivePrompt);
    // Baseline negatives already live in the template; append caller's, then recipe's.
    if (params.negativePrompt) {
      for (const id of ["7", "13"]) appendNodeText(graph, id, params.negativePrompt);
    }
    if (recipe?.extraNegatives) {
      for (const id of ["7", "13"]) appendNodeText(graph, id, recipe.extraNegatives);
    }
    const seed = params.seed ?? randomSeed();
    for (const id of ["3", "14"]) setNodeSeed(graph, id, seed);
    setNodeSize(graph, "5", params.width, params.height); // EmptyLatentImage (both workflows)
    setNodeCheckpoint(graph, "4", params.checkpoint); // base checkpoint override (both workflows)
    if (tier.steps != null && graph["3"] && "steps" in graph["3"].inputs) {
      graph["3"].inputs.steps = tier.steps; // base-sampler step override only
    }
    if (recipe) applyLora(graph, recipe);

    // IP-Adapter block — self-contained so it never taints the outer flow. Falls back to prompt-only
    // if the model isn't installed on the host or an upload/injection error occurs.
    const firstReference = params.references?.[0];
    if (firstReference) {
      try {
        if (await ipAdapterAvailable(base, fetchFn)) {
          const name = await uploadImage(base, fetchFn, firstReference);
          applyIPAdapter(
            graph,
            name,
            params.referenceStrength ?? REFERENCE_WEIGHT,
            params.referenceStart ?? REFERENCE_START,
            await nodeAvailable(base, fetchFn, PREP_NODE),
          );
        } else {
          console.error(
            "[engine] IP-Adapter not available on ComfyUI host — rendering without reference",
          );
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[engine] IP-Adapter reference failed (${reason}) — rendering without reference`);
      }
    }

    // img2img block — upload the starting image and repoint the sampler at its encoded latent. Unlike
    // the reference path, a failure here is NOT swallowed: silently rendering txt2img would ignore the
    // caller's image and hand back an unrelated picture, so the whole request fails cleanly instead.
    if (params.initImage) {
      try {
        const name = await uploadImage(base, fetchFn, params.initImage);
        applyImg2Img(graph, name, params.denoise ?? DENOISE_DEFAULT);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `img2img upload failed: ${reason}` };
      }
    }

    // Upscale block — a post-process tail on the final image. Resolve the model (request > config
    // default (threaded in as params.upscaleModel) > first installed) and fail cleanly if none is
    // installed, since the caller explicitly asked to upscale.
    if (params.upscale) {
      const model = params.upscaleModel || (await listUpscaleModels(base, fetchFn))[0];
      if (!model) {
        return {
          ok: false,
          error: "no upscale model installed on the ComfyUI host (add one to models/upscale_models/)",
        };
      }
      applyUpscale(graph, model, params.upscale);
      tier = { ...tier, timeoutMs: tier.timeoutMs + UPSCALE_TIMEOUT_BONUS_MS };
    }

    // POST /prompt
    const clientId = `imagegen-${randomSeed().toString(16)}`;
    const res = await fetchFn(`${base}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `ComfyUI /prompt returned ${res.status} ${body.slice(0, 200)}` };
    }
    const submit = (await res.json()) as {
      prompt_id?: string;
      node_errors?: Record<string, unknown>;
    };
    if (submit.node_errors && Object.keys(submit.node_errors).length) {
      return {
        ok: false,
        error: `ComfyUI rejected the workflow: ${JSON.stringify(submit.node_errors).slice(0, 300)}`,
      };
    }
    if (!submit.prompt_id) return { ok: false, error: "ComfyUI /prompt returned no prompt_id" };
    const promptId = submit.prompt_id;

    // Poll /history/<promptId> — ALWAYS this request's OWN id, never "latest". This is the
    // concurrency guarantee: request N resolves to request N's image, whatever the order.
    const deadline = Date.now() + tier.timeoutMs;
    let image: OutImage | undefined;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const h = await fetchFn(`${base}/history/${promptId}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => null);
      if (!h || !h.ok) continue;
      const hist = (await h.json().catch(() => ({}))) as Record<string, any>;
      const entry = hist[promptId]; // keyed by our prompt_id
      if (!entry) continue;
      if (entry.status?.status_str === "error") {
        return {
          ok: false,
          error: `ComfyUI execution error: ${JSON.stringify(entry.status).slice(0, 300)}`,
        };
      }
      for (const node of Object.values(entry.outputs ?? {}) as any[]) {
        const first = (node.images ?? [])[0] as OutImage | undefined;
        if (first) {
          image = first;
          break;
        }
      }
      if (image) break;
    }
    if (!image) return { ok: false, error: `ComfyUI produced no image within ${tier.timeoutMs}ms` };

    // Fetch the PNG bytes via /view.
    const q = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder,
      type: image.type,
    });
    const view = await fetchFn(`${base}/view?${q}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!view.ok) return { ok: false, error: `ComfyUI /view returned ${view.status}` };
    const bytes = Buffer.from(await view.arrayBuffer());
    return { ok: true, bytes };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `ComfyUI request failed: ${reason}` };
  }
}

// Scan a /history entry's outputs for the first produced file. Wan ends in SaveVideo, whose output
// key varies by ComfyUI build (images / gifs / videos), so take the first output array whose first
// element carries a `filename` rather than assuming an `images` array under a fixed node id.
function findOutputFile(entry: any): OutImage | undefined {
  for (const nodeOut of Object.values(entry?.outputs ?? {}) as any[]) {
    for (const val of Object.values(nodeOut ?? {})) {
      if (Array.isArray(val)) {
        const first = val.find((x) => x && typeof x === "object" && "filename" in x);
        if (first) return first as OutImage;
      }
    }
  }
  return undefined;
}

// Map an output filename's extension to a response content type. Wan's SaveVideo writes mp4; the
// other extensions cover alternate ComfyUI video/animation save nodes.
function contentTypeFor(filename: string): string {
  const f = filename.toLowerCase();
  if (f.endsWith(".mp4")) return "video/mp4";
  if (f.endsWith(".webm")) return "video/webm";
  if (f.endsWith(".webp")) return "image/webp";
  if (f.endsWith(".gif")) return "image/gif";
  if (f.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

// ---- image-to-video entry (ADR-0009) -----------------------------------------------------

// animateImage — turn a still into a short video with Wan 2.2 TI2V 5B. Parallels generateImage: same
// POST /prompt -> poll /history BY OWN prompt_id -> /view transport, same never-throw discipline. The
// image path (generateImage) is untouched. Two differences: a hard preflight on the Wan model files
// (animation cannot degrade to prompt-only), and a video-tier timeout that absorbs the model-load
// pause (ADR-0008).
export async function animateImage(
  comfyUrl: string,
  params: AnimateParams,
  fetchFn: FetchFn = fetch,
): Promise<AnimateResult> {
  const base = comfyBase(comfyUrl);
  const spec = getVideoModel(params.model);
  try {
    // Preflight: this model's files must be installed. Fail cleanly and actionably if not — unlike
    // the IP-Adapter path, there is no meaningful render without them.
    const missing = await videoModelsMissing(base, fetchFn, spec.files);
    if (missing.length) {
      return {
        ok: false,
        error: `${spec.label} model files not installed on the ComfyUI host: ${missing.join(", ")} — run ${spec.fetchHint}, then restart ComfyUI`,
      };
    }

    // Upload the still. A failure here is NOT swallowed (like img2img): without the input image there
    // is nothing to animate, so the whole request fails.
    let imageName: string;
    try {
      imageName = await uploadImage(base, fetchFn, params.image);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `input image upload failed: ${reason}` };
    }

    const graph = spec.render({
      prompt: params.prompt,
      negativePrompt: params.negativePrompt,
      seed: params.seed,
      width: params.width,
      height: params.height,
      frames: params.frames,
      fps: params.fps,
      imageName,
    });

    const clientId = `imagegen-${randomSeed().toString(16)}`;
    const res = await fetchFn(`${base}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `ComfyUI /prompt returned ${res.status} ${body.slice(0, 200)}` };
    }
    const submit = (await res.json()) as {
      prompt_id?: string;
      node_errors?: Record<string, unknown>;
    };
    if (submit.node_errors && Object.keys(submit.node_errors).length) {
      return {
        ok: false,
        error: `ComfyUI rejected the workflow: ${JSON.stringify(submit.node_errors).slice(0, 300)}`,
      };
    }
    if (!submit.prompt_id) return { ok: false, error: "ComfyUI /prompt returned no prompt_id" };
    const promptId = submit.prompt_id;

    // Poll /history/<promptId> by our OWN id (the concurrency guarantee). Video-tier budget.
    const deadline = Date.now() + ANIMATE_TIMEOUT_MS;
    let out: OutImage | undefined;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const h = await fetchFn(`${base}/history/${promptId}`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).catch(() => null);
      if (!h || !h.ok) continue;
      const hist = (await h.json().catch(() => ({}))) as Record<string, any>;
      const entry = hist[promptId];
      if (!entry) continue;
      if (entry.status?.status_str === "error") {
        return {
          ok: false,
          error: `ComfyUI execution error: ${JSON.stringify(entry.status).slice(0, 300)}`,
        };
      }
      out = findOutputFile(entry);
      if (out) break;
    }
    if (!out) return { ok: false, error: `ComfyUI produced no video within ${ANIMATE_TIMEOUT_MS}ms` };

    // Fetch the video bytes via /view (longer per-request budget than the image path).
    const q = new URLSearchParams({ filename: out.filename, subfolder: out.subfolder, type: out.type });
    const view = await fetchFn(`${base}/view?${q}`, {
      signal: AbortSignal.timeout(VIEW_TIMEOUT_MS),
    });
    if (!view.ok) return { ok: false, error: `ComfyUI /view returned ${view.status}` };
    const bytes = Buffer.from(await view.arrayBuffer());
    return { ok: true, bytes, contentType: contentTypeFor(out.filename), filename: out.filename };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `ComfyUI request failed: ${reason}` };
  }
}
