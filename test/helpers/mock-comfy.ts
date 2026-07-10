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
  // Simulate ComfyUI being down: every request rejects (network error).
  down?: boolean;
  // Make POST /prompt fail with this HTTP status (e.g. 400/500). Default: succeeds.
  promptStatus?: number;
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
];

export class MockComfy {
  readonly submitted: SubmittedPrompt[] = [];
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
