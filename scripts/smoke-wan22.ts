// Manual integration smoke test for the Wan 2.2 TI2V 5B image-to-video pipeline (ADR-0008). Renders
// the workflow template and submits it DIRECTLY to ComfyUI's HTTP API — bypassing the service — so
// the pipeline is proven on its own before Cycle 2 wires up a /animate endpoint.
//
// Usage:
//   npx tsx scripts/smoke-wan22.ts --image <path> --prompt "<text>" [--frames N] [--size WxH] \
//       [--comfy-url http://localhost:8188] [--out out.mp4] [--timeout-min 20]
//
// Fails LOUDLY (non-zero exit, clear message) if ComfyUI is unreachable or any of the three Wan model
// files is not advertised by ComfyUI. It never fabricates success — the output path it prints always
// corresponds to a video ComfyUI actually wrote.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { comboOptions } from "../src/engine.ts";
import { config } from "../src/config.ts";
import {
  renderWanWorkflow,
  WAN_DIFFUSION_MODEL,
  WAN_TEXT_ENCODER,
  WAN_VAE,
} from "../src/wan-workflow.ts";

interface Args {
  image: string;
  prompt: string;
  frames?: number;
  width?: number;
  height?: number;
  comfyUrl: string;
  out: string;
  timeoutMs: number;
}

function die(msg: string): never {
  console.error(`\nSMOKE FAILED: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("--")) die(`unexpected argument: ${key}`);
    const val = argv[++i];
    if (val === undefined) die(`${key} requires a value`);
    a[key.slice(2)] = val;
  }
  if (!a.image) die("--image <path> is required");
  if (!a.prompt) die("--prompt \"<text>\" is required");

  let width: number | undefined;
  let height: number | undefined;
  if (a.size) {
    const m = a.size.match(/^(\d+)x(\d+)$/i);
    if (!m) die(`--size must be WxH (e.g. 1280x704), got: ${a.size}`);
    width = Number(m[1]);
    height = Number(m[2]);
  }
  return {
    image: path.resolve(a.image),
    prompt: a.prompt,
    frames: a.frames !== undefined ? Number(a.frames) : undefined,
    width,
    height,
    comfyUrl: (a["comfy-url"] ?? config.comfyui.url ?? "http://localhost:8188").replace(/\/$/, ""),
    out: path.resolve(a.out ?? "wan-smoke-out.mp4"),
    timeoutMs: (a["timeout-min"] !== undefined ? Number(a["timeout-min"]) : 20) * 60_000,
  };
}

// Query one /object_info class and return the advertised names for a given combo input, or throw a
// clear "ComfyUI unreachable" error the caller reports loudly.
async function advertisedNames(base: string, cls: string, input: string): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${base}/object_info/${cls}`, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    die(`ComfyUI unreachable at ${base} (${reason}). Is ComfyUI running?`);
  }
  if (!res.ok) die(`ComfyUI /object_info/${cls} returned ${res.status} at ${base}.`);
  const info = (await res.json().catch(() => ({}))) as Record<string, any>;
  return comboOptions(info?.[cls]?.input?.required?.[input]);
}

async function assertModelsPresent(base: string): Promise<void> {
  const [unets, clips, vaes] = await Promise.all([
    advertisedNames(base, "UNETLoader", "unet_name"),
    advertisedNames(base, "CLIPLoader", "clip_name"),
    advertisedNames(base, "VAELoader", "vae_name"),
  ]);
  const missing: string[] = [];
  if (!unets.includes(WAN_DIFFUSION_MODEL)) missing.push(`diffusion_models/${WAN_DIFFUSION_MODEL}`);
  if (!clips.includes(WAN_TEXT_ENCODER)) missing.push(`text_encoders/${WAN_TEXT_ENCODER}`);
  if (!vaes.includes(WAN_VAE)) missing.push(`vae/${WAN_VAE}`);
  if (missing.length) {
    die(
      `ComfyUI is up but these Wan model files are not installed:\n  - ${missing.join("\n  - ")}\n` +
        `Run:  npx tsx scripts/fetch-wan22-models.ts   (then restart ComfyUI so it re-scans models).`,
    );
  }
}

async function uploadImage(base: string, imagePath: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(imagePath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    die(`cannot read --image ${imagePath} (${reason}).`);
  }
  const form = new FormData();
  form.append("image", new Blob([bytes]), path.basename(imagePath));
  form.append("overwrite", "true");
  let res: Response;
  try {
    res = await fetch(`${base}/upload/image`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    die(`upload of ${imagePath} failed (${reason}).`);
  }
  if (!res.ok) die(`ComfyUI /upload/image returned ${res.status}.`);
  const j = (await res.json().catch(() => ({}))) as { name?: string };
  if (!j.name) die("ComfyUI /upload/image returned no filename.");
  return j.name;
}

interface OutFile {
  filename: string;
  subfolder: string;
  type: string;
}

// SaveVideo reports its output under the node's outputs; the exact key ("images"/"gifs"/"videos")
// varies by ComfyUI build, so scan every output array for the first object carrying a filename.
function findOutputFile(entry: any): OutFile | undefined {
  for (const nodeOut of Object.values(entry?.outputs ?? {}) as any[]) {
    for (const val of Object.values(nodeOut ?? {})) {
      if (Array.isArray(val)) {
        const first = val.find((x) => x && typeof x === "object" && "filename" in x) as OutFile | undefined;
        if (first) return first;
      }
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const base = args.comfyUrl;

  console.log(`ComfyUI:  ${base}`);
  console.log(`Image:    ${args.image}`);
  console.log(`Prompt:   ${args.prompt}`);

  await assertModelsPresent(base);
  console.log("Models:   all three Wan 2.2 files present.");

  const imageName = await uploadImage(base, args.image);
  const graph = renderWanWorkflow({
    prompt: args.prompt,
    frames: args.frames,
    width: args.width,
    height: args.height,
    imageName,
  });
  console.log(
    `Render:   ${graph["55"].inputs.width}x${graph["55"].inputs.height}, ${graph["55"].inputs.length} frames @ ${graph["57"].inputs.fps}fps (seed ${graph["3"].inputs.seed}).`,
  );

  const clientId = `wan-smoke-${Date.now().toString(16)}`;
  let submit: Response;
  try {
    submit = await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: graph, client_id: clientId }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    die(`POST /prompt failed (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (!submit.ok) die(`ComfyUI /prompt returned ${submit.status}: ${(await submit.text().catch(() => "")).slice(0, 300)}`);
  const sub = (await submit.json()) as { prompt_id?: string; node_errors?: Record<string, unknown> };
  if (sub.node_errors && Object.keys(sub.node_errors).length) {
    die(`ComfyUI rejected the workflow: ${JSON.stringify(sub.node_errors).slice(0, 500)}`);
  }
  if (!sub.prompt_id) die("ComfyUI /prompt returned no prompt_id.");
  const promptId = sub.prompt_id;
  console.log(`Submitted: prompt_id=${promptId}. Rendering (this takes minutes)...`);

  const started = Date.now();
  const deadline = started + args.timeoutMs;
  let outFile: OutFile | undefined;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const h = await fetch(`${base}/history/${promptId}`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!h || !h.ok) continue;
    const hist = (await h.json().catch(() => ({}))) as Record<string, any>;
    const entry = hist[promptId];
    if (!entry) {
      process.stdout.write(".");
      continue;
    }
    if (entry.status?.status_str === "error") {
      die(`ComfyUI execution error: ${JSON.stringify(entry.status).slice(0, 500)}`);
    }
    outFile = findOutputFile(entry);
    if (outFile) break;
  }
  if (!outFile) die(`no video produced within ${Math.round(args.timeoutMs / 60000)} minutes.`);

  const q = new URLSearchParams({ filename: outFile.filename, subfolder: outFile.subfolder, type: outFile.type });
  const view = await fetch(`${base}/view?${q}`, { signal: AbortSignal.timeout(120_000) }).catch(() => null);
  if (!view || !view.ok) die(`ComfyUI /view returned ${view ? view.status : "no response"} for ${outFile.filename}.`);
  const bytes = Buffer.from(await view.arrayBuffer());
  writeFileSync(args.out, bytes);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\nOK — video written.`);
  console.log(`  elapsed: ${elapsed}s`);
  console.log(`  output:  ${args.out} (${(bytes.length / 1e6).toFixed(2)} MB)`);
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
