import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANIMATE_MODELS,
  DEFAULT_ANIMATE_MODEL,
  VIDEO_MODELS,
  getVideoModel,
  isAnimateModel,
} from "../src/video-models.ts";
import {
  LTXV_CHECKPOINT,
  LTXV_TEXT_ENCODER,
  normalizeLtxvFrames,
  normalizeLtxvDimension,
  renderLtxvWorkflow,
} from "../src/ltxv-workflow.ts";

test("registry: every spec is well-formed and keyed by its own model id", () => {
  for (const [key, spec] of Object.entries(VIDEO_MODELS)) {
    assert.equal(spec.model, key, `spec keyed "${key}" must have model "${key}"`);
    assert.ok(spec.label.length > 0);
    assert.ok(spec.files.length > 0, `${key} needs at least one preflight file`);
    assert.ok(spec.fetchHint.length > 0);
    assert.equal(typeof spec.render, "function");
    for (const f of spec.files) {
      assert.ok(f.loaderClass && f.inputName && f.file && f.subdir, `${key} file fields must be set`);
      assert.ok(f.file.endsWith(".safetensors"));
    }
  }
});

test("registry: wan-5b is the default and both models are registered", () => {
  assert.equal(DEFAULT_ANIMATE_MODEL, "wan-5b");
  assert.deepEqual(ANIMATE_MODELS.sort(), ["ltxv", "wan-5b"]);
  assert.equal(getVideoModel().model, "wan-5b"); // no arg => default
  assert.equal(getVideoModel(null).model, "wan-5b");
  assert.equal(getVideoModel("ltxv").model, "ltxv");
});

test("isAnimateModel: accepts registered ids, rejects everything else", () => {
  assert.equal(isAnimateModel("wan-5b"), true);
  assert.equal(isAnimateModel("ltxv"), true);
  assert.equal(isAnimateModel("sora"), false);
  assert.equal(isAnimateModel(""), false);
  assert.equal(isAnimateModel(42), false);
  assert.equal(isAnimateModel(undefined), false);
});

test("ltxv preflight files: the checkpoint + T5 text encoder, correct loaders/subdirs", () => {
  const files = getVideoModel("ltxv").files;
  const byFile = Object.fromEntries(files.map((f) => [f.file, f]));
  assert.equal(byFile[LTXV_CHECKPOINT]?.loaderClass, "CheckpointLoaderSimple");
  assert.equal(byFile[LTXV_CHECKPOINT]?.subdir, "checkpoints");
  assert.equal(byFile[LTXV_TEXT_ENCODER]?.loaderClass, "CLIPLoader");
  assert.equal(byFile[LTXV_TEXT_ENCODER]?.subdir, "text_encoders");
});

test("normalizeLtxvFrames: snaps to the 8n+1 grid and caps", () => {
  assert.equal(normalizeLtxvFrames(97), 97); // 8*12+1
  assert.equal(normalizeLtxvFrames(100), 97); // nearest 8n+1
  assert.equal(normalizeLtxvFrames(1), 1);
  assert.equal(normalizeLtxvFrames(0), 1);
  assert.equal(normalizeLtxvFrames(10_000), 121); // capped at LTXV_MAX_FRAMES (a valid 8n+1)
  assert.equal((normalizeLtxvFrames(50) - 1) % 8, 0);
});

test("normalizeLtxvDimension: snaps to multiples of 32 with a floor", () => {
  assert.equal(normalizeLtxvDimension(768, 768), 768);
  assert.equal(normalizeLtxvDimension(770, 768), 768);
  assert.equal(normalizeLtxvDimension(5, 512), 32); // floor
  assert.equal(normalizeLtxvDimension(undefined, 512), 512);
});

test("renderLtxvWorkflow: injects prompt/image/seed/dims/fps into the right nodes", () => {
  const g = renderLtxvWorkflow({
    prompt: "the meadow sways",
    negativePrompt: "flicker",
    seed: 123,
    width: 800, // -> 800 is 25*32, valid
    height: 500, // -> snaps to 512
    frames: 49, // 8*6+1
    fps: 30,
    imageName: "still-42.png",
  });
  assert.equal(g["6"]!.inputs.text, "the meadow sways"); // positive
  assert.match(String(g["7"]!.inputs.text), /flicker$/); // caller negative appended
  assert.equal(g["77"]!.inputs.width, 800);
  assert.equal(g["77"]!.inputs.height, 512);
  assert.equal(g["77"]!.inputs.length, 49);
  assert.equal(g["80"]!.inputs.fps, 30);
  assert.equal(g["72"]!.inputs.noise_seed, 123);
  assert.equal(g["78"]!.inputs.image, "still-42.png");
  // The checkpoint node still names the LTX model (untouched by the renderer).
  assert.equal(g["44"]!.inputs.ckpt_name, LTXV_CHECKPOINT);
});

test("renderLtxvWorkflow: a fresh clone per call — no shared mutable state", () => {
  const a = renderLtxvWorkflow({ prompt: "one", imageName: "a.png" });
  const b = renderLtxvWorkflow({ prompt: "two", imageName: "b.png" });
  assert.equal(a["6"]!.inputs.text, "one");
  assert.equal(b["6"]!.inputs.text, "two");
});
