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
