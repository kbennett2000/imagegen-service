// Style -> LoRA recipe map. Values reused VERBATIM from Chronicle's
// src/image-backends/style-loras.ts (clean-room reimplementation, no import). Keys are
// normalized (trim + lowercase). The service references LoRA files BY NAME; ComfyUI loads
// them from ~/comfyui/models/loras/.

export interface StyleLora {
  loraFile: string; // filename under ComfyUI models/loras/, .safetensors
  trigger: string; // token ensured present in the positive prompt (prepended if absent)
  strength: number; // applied to BOTH strength_model and strength_clip
  noRefiner?: boolean; // LoRA styles skip the refiner pass under quality=high (base only)
  extraNegatives?: string; // optional, appended to the negative CLIP nodes
}

export const STYLE_LORAS: Record<string, StyleLora> = {
  "pixel art": {
    loraFile: "pixel-art-xl.safetensors",
    trigger: "pixel art",
    strength: 1.0,
    noRefiner: true,
  },
  "oil painting": {
    loraFile: "ClassipeintXL2.1.safetensors",
    trigger: "oil painting",
    strength: 0.8,
    noRefiner: true,
  },
  "comic book": {
    loraFile: "EldritchComicsXL1.2.safetensors",
    trigger: "comic book",
    strength: 0.9,
    noRefiner: true,
    extraNegatives: "book, magazine",
  },
  "lego-style": {
    loraFile: "Lego_XL_v2.1.safetensors",
    trigger: "LEGO MiniFig",
    strength: 0.8,
    noRefiner: true,
  },
  "pencil sketch": {
    loraFile: "sketch_style.safetensors",
    trigger: "sketch",
    strength: 1.0,
    noRefiner: true,
  },
  watercolour: {
    loraFile: "watercolor-orie-xl.safetensors",
    trigger: "watercolor style",
    strength: 1.0,
    noRefiner: true,
  },
  anime: {
    loraFile: "animelora-sdxl.safetensors",
    trigger: "anime",
    strength: 0.9,
    noRefiner: true,
  },
  storybook: {
    loraFile: "StoryBookRedmond-KidsRedmAF.safetensors",
    trigger: "KidsRedmAF",
    strength: 1.0,
    noRefiner: true,
  },
  "3d": {
    loraFile: "PixarXL.safetensors",
    trigger: "pixar style",
    strength: 1.0,
    noRefiner: true,
  },
  cyberpunk: {
    loraFile: "cyberpunk_xl_v1.safetensors",
    trigger: "cyberpunk",
    strength: 0.8,
    noRefiner: true,
  },
  "ukiyo-e": {
    loraFile: "Ukiyo-e-Art-XL.safetensors",
    trigger: "Ukiyo-e Art",
    strength: 0.8,
    noRefiner: true,
  },
  claymation: {
    loraFile: "CLAYMATE-v2-sdxl.safetensors",
    trigger: "claymation",
    strength: 1.0,
    noRefiner: true,
  },
  // "noir" and "ghibli" are intentionally omitted (prompt-only; no reliable base-SDXL LoRA).
};

function normalizeStyleKey(style: string): string {
  return style.trim().toLowerCase();
}

export function lookupStyleLora(style?: string | null): StyleLora | undefined {
  if (!style) return undefined;
  return STYLE_LORAS[normalizeStyleKey(style)];
}

// Case-insensitive; prepends "<trigger>. " only if the token is not already present.
export function ensureTrigger(prompt: string, trigger: string): string {
  if (prompt.toLowerCase().includes(trigger.toLowerCase())) return prompt;
  return `${trigger}. ${prompt}`;
}
