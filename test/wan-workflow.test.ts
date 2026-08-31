import assert from "node:assert/strict";
import { test } from "node:test";

import {
  renderWanWorkflow,
  normalizeDimension,
  normalizeFrames,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  DEFAULT_FPS,
  DEFAULT_FRAMES,
  MAX_FRAMES,
} from "../src/wan-workflow.ts";

test("renderWanWorkflow: injects prompt, image, seed, and defaults", () => {
  const g = renderWanWorkflow({ prompt: "a fox trotting through snow", imageName: "still.png", seed: 42 });
  // Positive prompt on node 6; negative untouched (baseline Wan negative preserved).
  assert.equal(g["6"]!.inputs.text, "a fox trotting through snow");
  assert.ok(String(g["7"]!.inputs.text).length > 0);
  // Uploaded image name lands on LoadImage 52.
  assert.equal(g["52"]!.inputs.image, "still.png");
  // Seed on the sampler.
  assert.equal(g["3"]!.inputs.seed, 42);
  // Defaults applied to both the scaler and the latent builder.
  assert.equal(g["53"]!.inputs.width, DEFAULT_WIDTH);
  assert.equal(g["53"]!.inputs.height, DEFAULT_HEIGHT);
  assert.equal(g["55"]!.inputs.width, DEFAULT_WIDTH);
  assert.equal(g["55"]!.inputs.height, DEFAULT_HEIGHT);
  assert.equal(g["55"]!.inputs.length, DEFAULT_FRAMES);
  assert.equal(g["57"]!.inputs.fps, DEFAULT_FPS);
  // The Wan model files are pinned in the template.
  assert.equal(g["37"]!.inputs.unet_name, "wan2.2_ti2v_5B_fp16.safetensors");
  assert.equal(g["38"]!.inputs.clip_name, "umt5_xxl_fp8_e4m3fn_scaled.safetensors");
  assert.equal(g["39"]!.inputs.vae_name, "wan2.2_vae.safetensors");
});

test("renderWanWorkflow: explicit scaler node feeds the latent builder (arbitrary input sizes scaled)", () => {
  const g = renderWanWorkflow({ prompt: "p", imageName: "x.png", width: 640, height: 640 });
  // ImageScale 53 takes the loaded image and the latent node takes the scaled image — the graph
  // scales whatever size the caller supplied to the target resolution itself.
  assert.deepEqual(g["53"]!.inputs.image, ["52", 0]);
  assert.deepEqual(g["55"]!.inputs.start_image, ["53", 0]);
  assert.equal(g["53"]!.inputs.width, 640);
  assert.equal(g["55"]!.inputs.width, 640);
});

test("renderWanWorkflow: caller negative is appended to the baseline, not replacing it", () => {
  const g = renderWanWorkflow({ prompt: "p", imageName: "x.png", negativePrompt: "no birds" });
  const neg = String(g["7"]!.inputs.text);
  assert.ok(neg.endsWith(", no birds"));
  assert.ok(neg.length > ", no birds".length);
});

test("renderWanWorkflow: frame count capped at 121 and snapped to the 4k+1 grid", () => {
  assert.equal(renderWanWorkflow({ prompt: "p", imageName: "x.png", frames: 500 })["55"]!.inputs.length, MAX_FRAMES);
  assert.equal(renderWanWorkflow({ prompt: "p", imageName: "x.png", frames: 48 })["55"]!.inputs.length, 49);
  assert.equal(renderWanWorkflow({ prompt: "p", imageName: "x.png", frames: 1 })["55"]!.inputs.length, 1);
});

test("renderWanWorkflow: dimensions snapped to multiples of 32", () => {
  const g = renderWanWorkflow({ prompt: "p", imageName: "x.png", width: 641, height: 700 });
  assert.equal(Number(g["55"]!.inputs.width) % 32, 0);
  assert.equal(Number(g["55"]!.inputs.height) % 32, 0);
  assert.equal(g["53"]!.inputs.width, g["55"]!.inputs.width);
});

test("normalizeFrames: grid + cap", () => {
  assert.equal(normalizeFrames(undefined), DEFAULT_FRAMES);
  assert.equal(normalizeFrames(121), 121);
  assert.equal(normalizeFrames(122), 121);
  assert.equal(normalizeFrames(9), 9);
  assert.equal(normalizeFrames(10), 9); // rounds to nearest 4k+1
  assert.equal(normalizeFrames(11), 13);
  assert.equal(normalizeFrames(0), 1);
});

test("normalizeDimension: multiple-of-32 with a floor and fallback", () => {
  assert.equal(normalizeDimension(undefined, DEFAULT_WIDTH), DEFAULT_WIDTH);
  assert.equal(normalizeDimension(1280, 512), 1280);
  assert.equal(normalizeDimension(700, 512), 704);
  assert.equal(normalizeDimension(1, 512), 32); // floored, never below 32
});

test("renderWanWorkflow: fresh clone per call — no shared mutable state", () => {
  const a = renderWanWorkflow({ prompt: "first", imageName: "a.png" });
  const b = renderWanWorkflow({ prompt: "second", imageName: "b.png" });
  assert.equal(a["6"]!.inputs.text, "first");
  assert.equal(b["6"]!.inputs.text, "second");
  assert.notEqual(a, b);
});
