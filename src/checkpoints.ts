// Checkpoint catalog — a friendly-name -> ComfyUI checkpoint filename map, mirroring the
// style-loras.ts pattern. It gives callers a stable, discoverable set of SFW base models to pick
// from (GET /checkpoints), and lets /generate accept a friendly NAME (e.g. "dreamshaper") in the
// `checkpoint` field instead of only the raw ComfyUI filename.
//
// The files themselves are installed on the ComfyUI box (the installer fetches them from
// install/models.manifest into models/checkpoints/). The service references them BY NAME; a name
// that isn't in this catalog is treated as a raw filename and passed through unchanged, so existing
// callers that send a filename keep working (ADR-0004 / ADR-0014).

export interface CheckpointInfo {
  file: string; // exact filename under ComfyUI models/checkpoints/, as ComfyUI lists it (.safetensors)
  description: string; // one-line, shown by GET /checkpoints
}

// Keys are normalized (trim + lowercase). The default SDXL base is intentionally NOT listed here —
// it is the workflow-template default and is always available; this catalog is the *extra* curated
// SFW checkpoints. All are single-file SDXL checkpoints usable by the existing SDXL workflows.
export const CHECKPOINTS: Record<string, CheckpointInfo> = {
  realvisxl: {
    file: "RealVisXL_V5.0_fp16.safetensors",
    description: "Photorealistic people and scenes (RealVis XL v5).",
  },
  juggernaut: {
    file: "Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors",
    description: "Polished, photoreal all-rounder (Juggernaut XL v9).",
  },
  animagine: {
    file: "animagine-xl-3.1.safetensors",
    description: "High-quality anime illustration (Animagine XL 3.1).",
  },
  zavychroma: {
    file: "zavychromaxl_v100.safetensors",
    description: "Stylized, cinematic fantasy art (ZavyChroma XL).",
  },
  // --- Popular SFW SDXL checkpoints from Civitai (ADR-0016). All full (non-distilled) SDXL 1.0. ---
  dreamshaper: {
    file: "dreamshaperXL_alpha2Xl10.safetensors",
    description: "Versatile painterly-to-photoreal all-rounder (DreamShaper XL).",
  },
  realcartoon: {
    file: "realcartoonXL_v7.safetensors",
    description: "Stylized cartoon-realism blend (RealCartoon-XL v7).",
  },
  nightvision: {
    file: "nightvisionxl_V900.safetensors",
    description: "Photoreal portraits, natural-language prompts (NightVision XL).",
  },
  colorful: {
    file: "colorfulxl_v70.safetensors",
    description: "High-saturation, vivid general model (Colorful XL v7).",
  },
  samaritan3d: {
    file: "samaritan3dCartoon_v40SDXL.safetensors",
    description: "Pixar-style 3D cartoon characters (Samaritan 3D Cartoon v4).",
  },
  starlight: {
    file: "starlightXLAnimated_v3.safetensors",
    description: "Anime / animated illustration (Starlight XL Animated v3).",
  },
  // All are full (non-distilled) SDXL checkpoints, compatible with the existing SDXL workflows'
  // sampler settings (cfg 7, ~25 steps). Turbo/Lightning models are intentionally omitted — they
  // need ~4-8 steps and low cfg, which the current tiers don't provide.
};

function normalizeKey(name: string): string {
  return name.trim().toLowerCase();
}

// The catalog entry for a friendly name, or undefined if the name isn't catalogued.
export function lookupCheckpoint(name?: string | null): CheckpointInfo | undefined {
  if (!name) return undefined;
  return CHECKPOINTS[normalizeKey(name)];
}

// Resolve a user-supplied `checkpoint` value to a ComfyUI filename: a catalog NAME maps to its file;
// anything else (already a filename, or an unknown name) passes through unchanged. An empty/absent
// value resolves to undefined (=> keep the workflow template's own checkpoint).
export function resolveCheckpoint(value?: string | null): string | undefined {
  const v = (value ?? "").trim();
  if (!v) return undefined;
  return lookupCheckpoint(v)?.file ?? v;
}
