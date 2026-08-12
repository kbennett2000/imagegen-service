// The reusable engine, reimplemented from Chronicle's src/image-backends/local.ts (clean-room,
// no import). Responsibilities: quality tier -> workflow selection, style -> LoRA recipe
// injection (trigger + LoRA node + strength + noRefiner), and the ComfyUI transport
// (POST /prompt -> poll /history BY OWN prompt_id -> fetch /view). Never throws.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureTrigger, lookupStyleLora, type StyleLora } from "./style-loras.js";

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
  // multi-figure scene); lower it for a single-subject plate. See ADR-0005.
  referenceStart?: number;
}

// IP-Adapter models (installed on the ComfyUI host) + tuned defaults. SDXL base + CLIP-ViT-H
// image encoder.
//
// ADR-0005: conditioning starts PART-WAY through the schedule, not at step 0. Injecting identity
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

export type GenerateResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; error: string };

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

// Query ComfyUI's own filesystem for the LoRAs it can load. Used by /health and by the
// per-request availability check. Returns [] on any failure.
export async function listLoras(base: string, fetchFn: FetchFn): Promise<string[]> {
  try {
    const res = await fetchFn(`${base}/object_info/LoraLoader`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const info = (await res.json().catch(() => ({}))) as Record<string, any>;
    const names = info?.LoraLoader?.input?.required?.lora_name?.[0];
    return Array.isArray(names) ? (names as string[]) : [];
  } catch {
    return [];
  }
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
    const files = info?.IPAdapterModelLoader?.input?.required?.ipadapter_file?.[0];
    return Array.isArray(files) && files.includes(IPADAPTER_FILE);
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
// A unique name per upload avoids clobbering when requests overlap. Throws on failure (the caller
// catches and renders prompt-only).
async function uploadReference(base: string, fetchFn: FetchFn, b64: string): Promise<string> {
  const bytes = Buffer.from(b64, "base64");
  const filename = `ref-${randomSeed().toString(16)}.png`;
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
): Promise<{ reachable: boolean; loras: string[]; checkpoints: string[] }> {
  const base = comfyBase(comfyUrl);
  try {
    const res = await fetchFn(`${base}/object_info/LoraLoader`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return { reachable: false, loras: [], checkpoints: [] };
    const info = (await res.json().catch(() => ({}))) as Record<string, any>;
    const names = info?.LoraLoader?.input?.required?.lora_name?.[0];
    // Reachability is established; the checkpoint list is a best-effort second probe that must not
    // fail /health if it errors (returns [] then).
    const checkpoints = await listCheckpoints(base, fetchFn);
    return {
      reachable: true,
      loras: Array.isArray(names) ? (names as string[]) : [],
      checkpoints,
    };
  } catch {
    return { reachable: false, loras: [], checkpoints: [] };
  }
}

// The checkpoints ComfyUI can load (CheckpointLoaderSimple.ckpt_name). Returns [] on any failure.
export async function listCheckpoints(base: string, fetchFn: FetchFn): Promise<string[]> {
  try {
    const res = await fetchFn(`${base}/object_info/CheckpointLoaderSimple`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const info = (await res.json().catch(() => ({}))) as Record<string, any>;
    const names = info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
    return Array.isArray(names) ? (names as string[]) : [];
  } catch {
    return [];
  }
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

    // IP-Adapter needs the base graph's node ids (checkpoint "4", LoRA "20", sampler "3"); the
    // refiner graph has a different shape. Force base when references are present (like noRefiner).
    if (params.references?.length && tier.workflow === REFINER_WORKFLOW) {
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
          const name = await uploadReference(base, fetchFn, firstReference);
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
