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
  // --- Additional SFW styles (ADR-0014) ---
  "line art": {
    loraFile: "LineAniRedmondV2-Lineart-LineAniAF.safetensors",
    trigger: "LineAniAF, lineart",
    strength: 1.0,
    noRefiner: true,
  },
  "coloring book": {
    loraFile: "ColoringBookRedmond-ColoringBook-ColoringBookAF.safetensors",
    trigger: "ColoringBookAF, Coloring Book",
    strength: 1.0,
    noRefiner: true,
  },
  papercut: {
    loraFile: "papercut.safetensors",
    trigger: "papercut",
    strength: 1.0,
    noRefiner: true,
  },
  isometric: {
    loraFile: "Miniature_Isometric_Objects_3d_SDXL.safetensors",
    trigger: "isometric",
    strength: 1.0,
    noRefiner: true,
  },
  "stained glass": {
    loraFile: "stained_glass_style_v1_sdxl.safetensors",
    trigger: "stained glass",
    strength: 1.0,
    noRefiner: true,
  },
  embroidery: {
    loraFile: "embroidered_style_v1_sdxl.safetensors",
    trigger: "embroidery",
    strength: 1.0,
    noRefiner: true,
  },
  amigurumi: {
    loraFile: "AmiguramiRedmond-Crochet-Amigurumi.safetensors",
    trigger: "Amigurami, Crochet",
    strength: 1.0,
    noRefiner: true,
  },
  vaporwave: {
    loraFile: "vapor_graphic_sdxl.safetensors",
    trigger: "vapor_graphic",
    strength: 0.9,
    noRefiner: true,
  },
  "low-poly": {
    loraFile: "PS1Redmond-PS1Game-Playstation1Graphics.safetensors",
    trigger: "Playstation 1 Graphics, PS1 Game",
    strength: 1.0,
    noRefiner: true,
  },
  "art nouveau": {
    loraFile: "anime-nouveau-xl.safetensors",
    trigger: "art nouveau",
    strength: 0.8,
    noRefiner: true,
  },
  // --- More SFW styles sourced from Civitai (ADR-0016) ---
  "ink wash": {
    loraFile: "Zen_Ink_Wash_Sumi-e.safetensors",
    trigger: "sumi-e, ink wash painting",
    strength: 0.9,
    noRefiner: true,
  },
  "flat vector": {
    loraFile: "F2D-000003.safetensors",
    trigger: "flat color, vector art, clean lines, simple background",
    strength: 1.0,
    noRefiner: true,
  },
  "travel poster": {
    loraFile: "VintageTravelPoster01a_CE_SDXL_64x32x120x2bOT.safetensors",
    trigger: "vntgtrvlpstrCE style, travel poster",
    strength: 1.0,
    noRefiner: true,
  },
  sticker: {
    loraFile: "StickersRedmond.safetensors",
    trigger: "Stickers, Sticker",
    strength: 1.0,
    noRefiner: true,
  },
  gouache: {
    loraFile: "Gouache01a_CE_XL_200-OT.safetensors",
    trigger: "gcheCE_style, Gouache painting style",
    strength: 1.0,
    noRefiner: true,
  },
  charcoal: {
    loraFile: "Charcoal3.0.safetensors",
    trigger: "Charcoal drawing",
    strength: 1.0,
    noRefiner: true,
  },
  "art deco": {
    loraFile: "Art_Deco_Style_SDXL.safetensors",
    trigger: "ais-artdeco",
    strength: 0.9,
    noRefiner: true,
  },
  risograph: {
    loraFile: "risograph-sdxl.safetensors",
    trigger: "risograph",
    strength: 1.0,
    noRefiner: true,
  },
  "cel shading": {
    loraFile: "SDXLCelShading-000003.safetensors",
    trigger: "cel shading, anime",
    strength: 1.0,
    noRefiner: true,
  },
  woodcut: {
    loraFile: "wdct.safetensors",
    trigger: "wdct",
    strength: 1.0,
    noRefiner: true,
  },
  blueprint: {
    loraFile: "Technical_Blueprint_XL_SDXL_V2.0.safetensors",
    trigger: "Blueprint, Schematic Drawing, technical drawing",
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
