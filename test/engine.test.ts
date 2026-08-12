import assert from "node:assert/strict";
import { test } from "node:test";

import { generateImage } from "../src/engine.ts";
import { MockComfy } from "./helpers/mock-comfy.ts";

const URL = "http://localhost:8188";

test("style -> LoRA injection: node 20 LoraLoader wired in, trigger prepended", async () => {
  const mock = new MockComfy();
  const result = await generateImage(URL, { prompt: "a castle", style: "oil painting" }, mock.fetch);
  assert.equal(result.ok, true);
  assert.deepEqual((result as { ok: true; bytes: Buffer }).bytes, mock.bytesFor("pid-1"));

  const graph = mock.submitted[0]!.graph;
  // LoRA node injected as "20" with the recipe's file + strength on both model and clip.
  assert.equal(graph["20"].class_type, "LoraLoader");
  assert.equal(graph["20"].inputs.lora_name, "ClassipeintXL2.1.safetensors");
  assert.equal(graph["20"].inputs.strength_model, 0.8);
  assert.equal(graph["20"].inputs.strength_clip, 0.8);
  assert.deepEqual(graph["20"].inputs.model, ["4", 0]);
  assert.deepEqual(graph["20"].inputs.clip, ["4", 1]);
  // Edges repointed through the LoRA node.
  assert.deepEqual(graph["6"].inputs.clip, ["20", 1]);
  assert.deepEqual(graph["7"].inputs.clip, ["20", 1]);
  assert.deepEqual(graph["3"].inputs.model, ["20", 0]);
  // Trigger word prepended into the positive prompt.
  assert.equal(graph["6"].inputs.text, "oil painting. a castle");
});

test("style -> LoRA: trigger not duplicated when already present", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "an oil painting of a castle", style: "oil painting" }, mock.fetch);
  assert.equal(mock.submitted[0]!.graph["6"].inputs.text, "an oil painting of a castle");
});

test("quality -> tier: fast uses base workflow at 15 steps", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "x", quality: "fast" }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["3"].class_type, "KSampler"); // base sampler
  assert.equal(graph["3"].inputs.steps, 15);
  assert.equal(graph["11"], undefined); // no refiner checkpoint
});

test("quality -> tier: standard uses base workflow at 25 steps", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "x", quality: "standard" }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["3"].inputs.steps, 25);
  assert.equal(graph["11"], undefined);
});

test("quality -> tier: high (no style) uses the refiner workflow", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "x", quality: "high" }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["11"].class_type, "CheckpointLoaderSimple"); // refiner checkpoint present
  assert.equal(graph["12"].class_type, "CLIPTextEncode"); // refiner positive
  assert.equal(graph["3"].class_type, "KSamplerAdvanced"); // ensemble base pass
  assert.ok("noise_seed" in graph["3"].inputs);
});

test("noRefiner honored: LoRA style at quality=high renders base 40-step, no refiner", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "x", style: "anime", quality: "high" }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["11"], undefined); // refiner dropped
  assert.equal(graph["12"], undefined);
  assert.equal(graph["3"].class_type, "KSampler"); // base chain
  assert.equal(graph["3"].inputs.steps, 40); // high-steps on base
  assert.equal(graph["20"].inputs.lora_name, "animelora-sdxl.safetensors"); // LoRA still applied
});

test("unmapped style -> prompt-only graph (no LoRA, prompt unchanged)", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "a noir alley", style: "noir" }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["20"], undefined); // no LoRA node
  assert.equal(graph["6"].inputs.text, "a noir alley"); // no trigger injection
  assert.equal(graph["3"].inputs.steps, 25); // default standard tier
});

test("LoRA absent on host -> prompt-only fallback", async () => {
  const mock = new MockComfy({ loras: [] }); // ComfyUI reports no loras
  await generateImage(URL, { prompt: "a castle", style: "oil painting" }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["20"], undefined);
  assert.equal(graph["6"].inputs.text, "a castle"); // no trigger prepended
});

test("negativePrompt appends to baseline negatives; recipe extraNegatives too", async () => {
  const mock = new MockComfy();
  await generateImage(
    URL,
    { prompt: "a hero", style: "comic book", negativePrompt: "extra ugly" },
    mock.fetch,
  );
  const graph = mock.submitted[0]!.graph;
  assert.equal(
    graph["7"].inputs.text,
    "blurry, lowres, deformed, text, watermark, extra ugly, book, magazine",
  );
});

test("seed is honored when provided", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "x", seed: 12345 }, mock.fetch);
  assert.equal(mock.submitted[0]!.graph["3"].inputs.seed, 12345);
});

test("503-class failure: POST /prompt error -> { ok: false }", async () => {
  const mock = new MockComfy({ promptStatus: 500 });
  const result = await generateImage(URL, { prompt: "x" }, mock.fetch);
  assert.equal(result.ok, false);
});

test("503-class failure: ComfyUI down -> { ok: false }", async () => {
  const mock = new MockComfy({ down: true });
  const result = await generateImage(URL, { prompt: "x" }, mock.fetch);
  assert.equal(result.ok, false);
});

test("history execution error -> { ok: false }", async () => {
  const mock = new MockComfy({ historyError: () => true });
  const result = await generateImage(URL, { prompt: "x" }, mock.fetch);
  assert.equal(result.ok, false);
});

// CONCURRENCY (critical): two overlapping calls with distinct prompt_ids. The mock makes the
// SECOND submission finish first. Each call must resolve to ITS OWN image — no cross-delivery.
test("concurrency: overlapping calls resolve to their own prompt_id even when the 2nd finishes first", async () => {
  const mock = new MockComfy({
    // submission #1 not ready until its 3rd poll; #2 ready immediately -> #2 completes first.
    readyAfterPolls: (i) => (i === 1 ? 2 : 0),
  });

  const order: string[] = [];
  const p1 = generateImage(URL, { prompt: "first" }, mock.fetch).then((r) => {
    order.push("first");
    return r;
  });
  const p2 = generateImage(URL, { prompt: "second" }, mock.fetch).then((r) => {
    order.push("second");
    return r;
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ok, true);
  assert.equal(r2.ok, true);

  // The two submissions got distinct prompt_ids.
  assert.equal(mock.submitted.length, 2);
  const id1 = mock.submitted.find((s) => s.graph["6"].inputs.text === "first")!.promptId;
  const id2 = mock.submitted.find((s) => s.graph["6"].inputs.text === "second")!.promptId;
  assert.notEqual(id1, id2);

  // The second call finished first...
  assert.equal(order[0], "second");
  // ...yet each call received the PNG bytes tied to ITS OWN prompt_id (no cross-delivery).
  assert.deepEqual((r1 as { ok: true; bytes: Buffer }).bytes, mock.bytesFor(id1));
  assert.deepEqual((r2 as { ok: true; bytes: Buffer }).bytes, mock.bytesFor(id2));
});

test("width/height -> EmptyLatentImage node 5 sized to the request", async () => {
  const mock = new MockComfy();
  const result = await generateImage(URL, { prompt: "x", width: 832, height: 1216 }, mock.fetch);
  assert.equal(result.ok, true);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["5"].class_type, "EmptyLatentImage");
  assert.equal(graph["5"].inputs.width, 832);
  assert.equal(graph["5"].inputs.height, 1216);
});

test("no width/height -> node 5 keeps the workflow default (1024x1024)", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "x" }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["5"].inputs.width, 1024);
  assert.equal(graph["5"].inputs.height, 1024);
});

// ---- IP-Adapter reference-image (character consistency) --------------------------------------

const REF_B64 = Buffer.from("fake-portrait-png-bytes").toString("base64");

test("references -> IP-Adapter chain injected + reference uploaded", async () => {
  const mock = new MockComfy();
  const result = await generateImage(URL, { prompt: "a man in a street", references: [REF_B64] }, mock.fetch);
  assert.equal(result.ok, true);

  assert.equal(mock.uploads.length, 1); // the reference was uploaded to ComfyUI
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["21"].class_type, "LoadImage");
  assert.equal(graph["22"].class_type, "IPAdapterModelLoader");
  assert.equal(graph["22"].inputs.ipadapter_file, "ip-adapter-plus-face_sdxl_vit-h.safetensors");
  assert.equal(graph["23"].class_type, "CLIPVisionLoader");
  assert.equal(graph["24"].class_type, "IPAdapterAdvanced");
  // No LoRA, so the IP-Adapter takes the model straight from the checkpoint; sampler <- IP-Adapter.
  assert.deepEqual(graph["24"].inputs.model, ["4", 0]);
  // The adapter reads the CROPPED image (25), not the raw upload (21) — ADR-0007.
  assert.deepEqual(graph["24"].inputs.image, ["25", 0]);
  assert.deepEqual(graph["3"].inputs.model, ["24", 0]);
  assert.equal(graph["24"].inputs.weight, 0.5); // tuned default
});

// --- ADR-0007: identity, not composition ------------------------------------

test("IP-Adapter starts part-way through the schedule so the prompt owns composition", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "two people talking", references: [REF_B64] }, mock.fetch);
  const ipa = mock.submitted[0]!.graph["24"].inputs;
  // start_at > 0 is the whole point: the early high-noise steps decide layout and figure count,
  // and they must belong to the text prompt alone.
  assert.equal(ipa.start_at, 0.3);
  assert.equal(ipa.end_at, 1.0);
  assert.equal(ipa.weight_type, "ease in-out");
});

test("referenceStart overrides the default schedule offset", async () => {
  const mock = new MockComfy();
  await generateImage(
    URL,
    { prompt: "a man", references: [REF_B64], referenceStart: 0.45 },
    mock.fetch,
  );
  assert.equal(mock.submitted[0]!.graph["24"].inputs.start_at, 0.45);
});

test("the reference is head-cropped before the CLIP-vision encode", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "a man", references: [REF_B64] }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["25"].class_type, "PrepImageForClipVision");
  assert.deepEqual(graph["25"].inputs.image, ["21", 0]); // crops the uploaded reference
  assert.equal(graph["25"].inputs.crop_position, "top"); // the head of a bust portrait
  assert.deepEqual(graph["24"].inputs.image, ["25", 0]);
});

test("crop node absent on host -> conditions on the raw reference, still renders", async () => {
  const mock = new MockComfy({ nodes: [] }); // older IPAdapter pack, no PrepImageForClipVision
  const result = await generateImage(URL, { prompt: "a man", references: [REF_B64] }, mock.fetch);
  assert.equal(result.ok, true);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["25"], undefined);
  assert.deepEqual(graph["24"].inputs.image, ["21", 0]); // falls back to the uncropped upload
  assert.equal(graph["24"].inputs.start_at, 0.3); // the schedule offset still applies
});

test("references + style: IP-Adapter chains AFTER the LoRA (model 4 -> 20 -> 24 -> sampler)", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "a man", style: "oil painting", references: [REF_B64] }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.deepEqual(graph["20"].inputs.model, ["4", 0]); // LoRA from checkpoint
  assert.deepEqual(graph["24"].inputs.model, ["20", 0]); // IP-Adapter from LoRA output
  assert.deepEqual(graph["3"].inputs.model, ["24", 0]); // sampler from IP-Adapter
});

test("no references -> no IP-Adapter nodes (unchanged txt2img)", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "a man in a street" }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["24"], undefined);
  assert.equal(graph["21"], undefined);
  assert.equal(mock.uploads.length, 0);
  assert.deepEqual(graph["3"].inputs.model, ["4", 0]);
});

test("references but IP-Adapter absent on host -> falls back to prompt-only", async () => {
  const mock = new MockComfy({ ipadapters: [] }); // node/model not installed
  const result = await generateImage(URL, { prompt: "a man", references: [REF_B64] }, mock.fetch);
  assert.equal(result.ok, true); // still renders
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["24"], undefined); // no IP-Adapter injected
  assert.deepEqual(graph["3"].inputs.model, ["4", 0]);
});

test("referenceStrength overrides the default IP-Adapter weight", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "a man", references: [REF_B64], referenceStrength: 0.8 }, mock.fetch);
  assert.equal(mock.submitted[0]!.graph["24"].inputs.weight, 0.8);
});

test("checkpoint override -> base workflow node 4 ckpt_name is replaced", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "x", checkpoint: "juggernautXL_ragnarok.safetensors" }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["4"].class_type, "CheckpointLoaderSimple");
  assert.equal(graph["4"].inputs.ckpt_name, "juggernautXL_ragnarok.safetensors");
});

test("checkpoint override at quality=high -> base node 4 replaced, refiner node 11 left stock", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "x", quality: "high", checkpoint: "my_model.safetensors" }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["4"].inputs.ckpt_name, "my_model.safetensors"); // base overridden
  assert.equal(graph["11"].inputs.ckpt_name, "sd_xl_refiner_1.0.safetensors"); // refiner untouched
});

test("no checkpoint override -> node 4 keeps the workflow template default", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "x" }, mock.fetch);
  assert.equal(mock.submitted[0]!.graph["4"].inputs.ckpt_name, "sd_xl_base_1.0.safetensors");
});

test("checkpoint override composes with a LoRA style (node 20 still reads from node 4)", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "x", style: "anime", checkpoint: "custom.safetensors" }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["4"].inputs.ckpt_name, "custom.safetensors");
  assert.equal(graph["20"].class_type, "LoraLoader");
  assert.deepEqual(graph["20"].inputs.model, ["4", 0]); // LoRA still draws from the (overridden) checkpoint
});

// ---- img2img (initImage / denoise) ----

test("img2img: initImage encodes to latent and repoints the sampler with lowered denoise", async () => {
  const mock = new MockComfy();
  const result = await generateImage(URL, { prompt: "a castle", initImage: REF_B64, denoise: 0.6 }, mock.fetch);
  assert.equal(result.ok, true);
  assert.equal(mock.uploads.length, 1); // starting image uploaded to ComfyUI
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["30"].class_type, "LoadImage"); // loads the uploaded image
  assert.equal(graph["31"].class_type, "VAEEncode"); // encodes it to a latent
  assert.deepEqual(graph["31"].inputs.pixels, ["30", 0]);
  assert.deepEqual(graph["31"].inputs.vae, ["10", 0]); // uses the workflow VAELoader
  assert.deepEqual(graph["3"].inputs.latent_image, ["31", 0]); // sampler starts from the image
  assert.equal(graph["3"].inputs.denoise, 0.6);
});

test("img2img: denoise defaults to 0.65 when omitted", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "x", initImage: REF_B64 }, mock.fetch);
  assert.equal(mock.submitted[0]!.graph["3"].inputs.denoise, 0.65);
});

test("img2img: no initImage -> plain txt2img (EmptyLatentImage, denoise 1)", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "x" }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["30"], undefined);
  assert.equal(graph["31"], undefined);
  assert.deepEqual(graph["3"].inputs.latent_image, ["5", 0]); // still the empty latent
  assert.equal(graph["3"].inputs.denoise, 1);
});

test("img2img: forces the base workflow at quality=high (no refiner)", async () => {
  const mock = new MockComfy();
  await generateImage(URL, { prompt: "x", initImage: REF_B64, quality: "high" }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["11"], undefined); // refiner checkpoint dropped
  assert.equal(graph["3"].class_type, "KSampler"); // base sampler
  assert.deepEqual(graph["3"].inputs.latent_image, ["31", 0]); // img2img applied
});

test("img2img: composes with a LoRA style and a checkpoint override", async () => {
  const mock = new MockComfy();
  await generateImage(
    URL,
    { prompt: "x", style: "anime", checkpoint: "custom.safetensors", initImage: REF_B64 },
    mock.fetch,
  );
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["20"].class_type, "LoraLoader"); // LoRA still applied
  assert.equal(graph["4"].inputs.ckpt_name, "custom.safetensors"); // checkpoint override applied
  assert.deepEqual(graph["3"].inputs.latent_image, ["31", 0]); // img2img latent
});

test("img2img: a failed upload returns a clean error (no silent txt2img)", async () => {
  const mock = new MockComfy({ uploadStatus: 500 });
  const result = await generateImage(URL, { prompt: "x", initImage: REF_B64 }, mock.fetch);
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; error: string }).error, /img2img upload failed/);
  assert.equal(mock.submitted.length, 0); // never reached /prompt
});

// ---- upscaling (upscale / upscaleModel) ----

import { parseUpscaleFactor } from "../src/engine.ts";

test("parseUpscaleFactor reads the native factor from the model name", () => {
  assert.equal(parseUpscaleFactor("4x-UltraSharp.pth"), 4);
  assert.equal(parseUpscaleFactor("RealESRGAN_x4plus.pth"), 4);
  assert.equal(parseUpscaleFactor("2x_foo.pth"), 2);
  assert.equal(parseUpscaleFactor("no-number-here.pth"), 4); // default
});

test("upscale: factor == model native -> UpscaleModelLoader + ImageUpscaleWithModel, no scale-by", async () => {
  const mock = new MockComfy({ upscaleModels: ["RealESRGAN_x4plus.pth"] });
  const result = await generateImage(URL, { prompt: "x", upscale: 4 }, mock.fetch);
  assert.equal(result.ok, true);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["40"].class_type, "UpscaleModelLoader");
  assert.equal(graph["40"].inputs.model_name, "RealESRGAN_x4plus.pth");
  assert.equal(graph["41"].class_type, "ImageUpscaleWithModel");
  assert.deepEqual(graph["41"].inputs.image, ["8", 0]); // upscales the final decoded image
  assert.equal(graph["42"], undefined); // native == requested, no correction pass
  assert.deepEqual(graph["9"].inputs.images, ["41", 0]); // SaveImage <- upscaled
});

test("upscale: factor < native adds an ImageScaleBy correction (scale_by native-relative)", async () => {
  const mock = new MockComfy({ upscaleModels: ["RealESRGAN_x4plus.pth"] }); // native 4x
  await generateImage(URL, { prompt: "x", upscale: 2 }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.equal(graph["42"].class_type, "ImageScaleBy");
  assert.equal(graph["42"].inputs.scale_by, 0.5); // 2 / 4
  assert.deepEqual(graph["42"].inputs.image, ["41", 0]);
  assert.deepEqual(graph["9"].inputs.images, ["42", 0]);
});

test("upscale: explicit upscaleModel is used verbatim", async () => {
  const mock = new MockComfy({ upscaleModels: ["a.pth", "b.pth"] });
  await generateImage(URL, { prompt: "x", upscale: 4, upscaleModel: "b.pth" }, mock.fetch);
  assert.equal(mock.submitted[0]!.graph["40"].inputs.model_name, "b.pth");
});

test("upscale: no model installed -> clean error, never reaches /prompt", async () => {
  const mock = new MockComfy({ upscaleModels: [] });
  const result = await generateImage(URL, { prompt: "x", upscale: 2 }, mock.fetch);
  assert.equal(result.ok, false);
  assert.match((result as { ok: false; error: string }).error, /no upscale model/);
  assert.equal(mock.submitted.length, 0);
});

test("upscale: composes with img2img (upscales node 8, the final image)", async () => {
  const mock = new MockComfy({ upscaleModels: ["RealESRGAN_x4plus.pth"] });
  await generateImage(URL, { prompt: "x", initImage: REF_B64, upscale: 4 }, mock.fetch);
  const graph = mock.submitted[0]!.graph;
  assert.deepEqual(graph["3"].inputs.latent_image, ["31", 0]); // img2img still applied
  assert.deepEqual(graph["41"].inputs.image, ["8", 0]); // upscale reads the decoded output
  assert.deepEqual(graph["9"].inputs.images, ["41", 0]);
});

import { comboOptions } from "../src/engine.ts";

test("comboOptions handles both ComfyUI object_info schemas", () => {
  // legacy: [[...names...], {...}]
  assert.deepEqual(comboOptions([["a.pth", "b.pth"], { foo: 1 }]), ["a.pth", "b.pth"]);
  // newer: ["COMBO", { options: [...names...] }]
  assert.deepEqual(comboOptions(["COMBO", { multiselect: false, options: ["c.pth"] }]), ["c.pth"]);
  // junk / empty
  assert.deepEqual(comboOptions(undefined), []);
  assert.deepEqual(comboOptions(["COMBO", {}]), []);
});
