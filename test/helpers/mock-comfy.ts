// A configurable in-memory mock of ComfyUI's HTTP surface, used to drive generateImage /
// the server with no GPU and no running ComfyUI. It plays the four endpoints the engine uses:
//   GET  /object_info/LoraLoader   -> advertised lora_name list
//   POST /prompt                   -> assigns a prompt_id, records the submitted graph
//   GET  /history/<prompt_id>      -> per-id status/outputs (readiness controllable)
//   GET  /view?filename&...        -> the PNG bytes for that image
// It is a drop-in for `fetch` (a FetchFn).

import type { FetchFn } from "../../src/engine.ts";

export interface MockOptions {
  // LoRA files ComfyUI claims it can load (drives loraAvailable / /health). Default: a broad set.
  loras?: string[];
  // IP-Adapter model files ComfyUI claims it can load (drives ipAdapterAvailable). Default: the
  // installed face model. Set to [] to simulate the node/model being absent.
  ipadapters?: string[];
  // Checkpoint files ComfyUI claims it can load (drives /health checkpoints). Default: the stock
  // SDXL pair.
  checkpoints?: string[];
  // Custom node classes the host claims to have, beyond the loaders above (drives nodeAvailable /
  // the optional face crop). Default: PrepImageForClipVision present. Set to [] to simulate an
  // older IPAdapter pack without it.
  nodes?: string[];
  // Upscale models ComfyUI claims it can load (drives /health upscaleModels + the upscale path).
  // Default: [] (none installed) so the "no upscale model" error path is the default.
  upscaleModels?: string[];
  // Simulate ComfyUI being down: every request rejects (network error).
  down?: boolean;
  // Make POST /prompt fail with this HTTP status (e.g. 400/500). Default: succeeds.
  promptStatus?: number;
  // Make POST /upload/image fail with this HTTP status (drives the img2img upload-failure path).
  uploadStatus?: number;
  // Number of history polls before a given prompt_id reports its image ready. Default: 0
  // (ready on the very first poll). Keyed by the 1-based submission order.
  readyAfterPolls?: (submissionIndex: number) => number;
  // Report an execution error for a prompt instead of an image.
  historyError?: (submissionIndex: number) => boolean;
}

export interface SubmittedPrompt {
  promptId: string;
  index: number; // 1-based submission order
  graph: Record<string, any>;
  clientId: string;
}

const DEFAULT_LORAS = [
  "pixel-art-xl.safetensors",
  "ClassipeintXL2.1.safetensors",
  "EldritchComicsXL1.2.safetensors",
  "Lego_XL_v2.1.safetensors",
  "sketch_style.safetensors",
  "watercolor-orie-xl.safetensors",
  "animelora-sdxl.safetensors",
  "StoryBookRedmond-KidsRedmAF.safetensors",
  "PixarXL.safetensors",
  "cyberpunk_xl_v1.safetensors",
  "Ukiyo-e-Art-XL.safetensors",
  "CLAYMATE-v2-sdxl.safetensors",
  "LineAniRedmondV2-Lineart-LineAniAF.safetensors",
  "ColoringBookRedmond-ColoringBook-ColoringBookAF.safetensors",
  "papercut.safetensors",
  "Miniature_Isometric_Objects_3d_SDXL.safetensors",
  "stained_glass_style_v1_sdxl.safetensors",
  "embroidered_style_v1_sdxl.safetensors",
  "AmiguramiRedmond-Crochet-Amigurumi.safetensors",
  "vapor_graphic_sdxl.safetensors",
  "PS1Redmond-PS1Game-Playstation1Graphics.safetensors",
  "anime-nouveau-xl.safetensors",
];

const DEFAULT_IPADAPTERS = ["ip-adapter-plus-face_sdxl_vit-h.safetensors"];

const DEFAULT_CHECKPOINTS = ["sd_xl_base_1.0.safetensors", "sd_xl_refiner_1.0.safetensors"];

// Optional node classes a stock ComfyUI + IPAdapter_plus install provides.
const DEFAULT_NODES = ["PrepImageForClipVision"];

export class MockComfy {
  readonly submitted: SubmittedPrompt[] = [];
  readonly uploads: string[] = []; // filenames POSTed to /upload/image
  private readonly pollCounts = new Map<string, number>();
  private readonly opts: MockOptions;

  constructor(opts: MockOptions = {}) {
    this.opts = opts;
  }

  // The bytes /view returns for a prompt — a tiny PNG-ish buffer that encodes the prompt_id so
  // tests can assert no cross-delivery.
  bytesFor(promptId: string): Buffer {
    const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return Buffer.concat([PNG_MAGIC, Buffer.from(`img:${promptId}`, "utf8")]);
  }

  private jsonResponse(status: number, payload: unknown): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  get fetch(): FetchFn {
    const handler = async (
      input: Parameters<FetchFn>[0],
      init?: Parameters<FetchFn>[1],
    ): Promise<Response> => {
      if (this.opts.down) throw new TypeError("fetch failed (mock ComfyUI down)");

      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.replace(/^https?:\/\/[^/]+/, "");

      // GET /object_info/LoraLoader
      if (method === "GET" && path.startsWith("/object_info/LoraLoader")) {
        const loras = this.opts.loras ?? DEFAULT_LORAS;
        return this.jsonResponse(200, {
          LoraLoader: { input: { required: { lora_name: [loras] } } },
        });
      }

      // GET /object_info/CheckpointLoaderSimple — advertises the installed checkpoint files.
      if (method === "GET" && path.startsWith("/object_info/CheckpointLoaderSimple")) {
        const checkpoints = this.opts.checkpoints ?? DEFAULT_CHECKPOINTS;
        return this.jsonResponse(200, {
          CheckpointLoaderSimple: { input: { required: { ckpt_name: [checkpoints] } } },
        });
      }

      // GET /object_info/UpscaleModelLoader — advertises the installed upscale models. Uses ComfyUI's
      // NEWER combo schema (`["COMBO", {options:[...]}]`), which this node emits on real servers even
      // while the checkpoint/lora loaders still use the legacy `[[...],{}]` shape.
      if (method === "GET" && path.startsWith("/object_info/UpscaleModelLoader")) {
        const models = this.opts.upscaleModels ?? [];
        return this.jsonResponse(200, {
          UpscaleModelLoader: {
            input: { required: { model_name: ["COMBO", { multiselect: false, options: models }] } },
          },
        });
      }

      // GET /object_info/IPAdapterModelLoader — advertises the installed IP-Adapter model files.
      if (method === "GET" && path.startsWith("/object_info/IPAdapterModelLoader")) {
        const files = this.opts.ipadapters ?? DEFAULT_IPADAPTERS;
        return this.jsonResponse(200, {
          IPAdapterModelLoader: { input: { required: { ipadapter_file: [files] } } },
        });
      }

      // GET /object_info/<OtherClass> — presence probe for optional nodes. 404 when absent, so
      // the engine's `nodeAvailable` sees exactly what a host without the node would return.
      if (method === "GET" && path.startsWith("/object_info/")) {
        const cls = decodeURIComponent(path.slice("/object_info/".length).split("?")[0]!);
        const nodes = this.opts.nodes ?? DEFAULT_NODES;
        if (!nodes.includes(cls)) return new Response("not found", { status: 404 });
        return this.jsonResponse(200, { [cls]: { input: { required: {} } } });
      }

      // POST /upload/image — stores a reference image; returns its filename.
      if (method === "POST" && path === "/upload/image") {
        if (this.opts.uploadStatus && this.opts.uploadStatus >= 400) {
          return new Response("upload rejected", { status: this.opts.uploadStatus });
        }
        const name = `ref-mock-${this.uploads.length + 1}.png`;
        this.uploads.push(name);
        return this.jsonResponse(200, { name, subfolder: "", type: "input" });
      }

      // POST /prompt
      if (method === "POST" && path === "/prompt") {
        if (this.opts.promptStatus && this.opts.promptStatus >= 400) {
          return new Response("rejected", { status: this.opts.promptStatus });
        }
        const body = JSON.parse(String(init?.body ?? "{}"));
        const index = this.submitted.length + 1;
        const promptId = `pid-${index}`;
        this.submitted.push({
          promptId,
          index,
          graph: body.prompt,
          clientId: body.client_id,
        });
        return this.jsonResponse(200, { prompt_id: promptId, node_errors: {} });
      }

      // GET /history/<prompt_id>
      if (method === "GET" && path.startsWith("/history/")) {
        const promptId = decodeURIComponent(path.slice("/history/".length));
        const sub = this.submitted.find((s) => s.promptId === promptId);
        if (!sub) return this.jsonResponse(200, {});

        const seen = (this.pollCounts.get(promptId) ?? 0) + 1;
        this.pollCounts.set(promptId, seen);

        if (this.opts.historyError?.(sub.index)) {
          return this.jsonResponse(200, {
            [promptId]: { status: { status_str: "error", messages: [] }, outputs: {} },
          });
        }

        const readyAfter = this.opts.readyAfterPolls?.(sub.index) ?? 0;
        if (seen <= readyAfter) {
          // Not ready yet — empty entry so the poll loop keeps waiting.
          return this.jsonResponse(200, {});
        }
        return this.jsonResponse(200, {
          [promptId]: {
            status: { status_str: "success" },
            outputs: {
              "9": {
                images: [{ filename: `${promptId}.png`, subfolder: "", type: "output" }],
              },
            },
          },
        });
      }

      // GET /view?filename=<pid>.png
      if (method === "GET" && path.startsWith("/view")) {
        const q = new URLSearchParams(url.split("?")[1] ?? "");
        const filename = q.get("filename") ?? "";
        const promptId = filename.replace(/\.png$/, "");
        return new Response(this.bytesFor(promptId), {
          status: 200,
          headers: { "content-type": "image/png" },
        });
      }

      return new Response("not found", { status: 404 });
    };
    return handler as unknown as FetchFn;
  }
}
