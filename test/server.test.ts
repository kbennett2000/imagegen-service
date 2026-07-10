import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import type { Config } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { MockComfy } from "./helpers/mock-comfy.ts";

const CONFIG: Config = {
  comfyui: { url: "http://localhost:8188" },
  server: { host: "127.0.0.1", port: 0 },
  auth: { enabled: false, token: "" },
};

// Start the service on an ephemeral port with an injected mock ComfyUI; return base URL + close.
// Pass a config override (e.g. to enable auth) for tests that need one; defaults to open CONFIG.
async function startService(
  mock: MockComfy,
  config: Config = CONFIG,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer(config, mock.fetch);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("POST /generate -> 200 image/png with the produced bytes", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a castle", style: "oil painting", quality: "standard" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, mock.bytesFor("pid-1"));
  } finally {
    await svc.close();
  }
});

test("POST /generate -> 422 on missing prompt", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ style: "oil painting" }),
    });
    assert.equal(res.status, 422);
    const body = (await res.json()) as any;
    assert.match(body.error, /prompt/);
    assert.equal(mock.submitted.length, 0); // never reached ComfyUI
  } finally {
    await svc.close();
  }
});

test("POST /generate -> 422 on invalid quality", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x", quality: "ultra" }),
    });
    assert.equal(res.status, 422);
  } finally {
    await svc.close();
  }
});

test("POST /generate -> 503 when ComfyUI is down", async () => {
  const mock = new MockComfy({ down: true });
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "x" }),
    });
    assert.equal(res.status, 503);
    const body = (await res.json()) as any;
    assert.ok(typeof body.error === "string" && body.error.length > 0);
    assert.ok(!/\n\s+at\s/.test(body.error)); // never leak a stack trace
  } finally {
    await svc.close();
  }
});

test("GET /styles -> lists the preset styles with their recipes", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/styles`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.ok(Array.isArray(body.styles));
    assert.equal(body.styles.length, 12);
    const oil = body.styles.find((s: any) => s.name === "oil painting");
    assert.deepEqual(oil, {
      name: "oil painting",
      hasLora: true,
      trigger: "oil painting",
      strength: 0.8,
      loraFile: "ClassipeintXL2.1.safetensors",
    });
  } finally {
    await svc.close();
  }
});

test("GET /health -> reachable with the recipe LoRAs actually present", async () => {
  // ComfyUI reports only two of the recipe loras present.
  const mock = new MockComfy({
    loras: ["ClassipeintXL2.1.safetensors", "PixarXL.safetensors", "some-other.safetensors"],
  });
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.comfyuiReachable, true);
    assert.equal(body.comfyuiUrl, "http://localhost:8188");
    assert.deepEqual(body.lorasLoaded.sort(), ["ClassipeintXL2.1.safetensors", "PixarXL.safetensors"]);
  } finally {
    await svc.close();
  }
});

test("GET /health -> unreachable ComfyUI reports reachable:false, no loras", async () => {
  const mock = new MockComfy({ down: true });
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.comfyuiReachable, false);
    assert.deepEqual(body.lorasLoaded, []);
  } finally {
    await svc.close();
  }
});

test("unknown route -> 404 JSON", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/nope`);
    assert.equal(res.status, 404);
    const body = (await res.json()) as any;
    assert.ok(typeof body.error === "string");
  } finally {
    await svc.close();
  }
});

// ---- Optional shared-token auth (ADR-0002) ----

const AUTH_CONFIG: Config = {
  comfyui: { url: "http://localhost:8188" },
  server: { host: "127.0.0.1", port: 0 },
  auth: { enabled: true, token: "s3cret-token" },
};

// ---- Built-in dev/test UI (served at / and /index.html) ----

test("GET / -> 200 text/html with the test-UI form", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
    const html = await res.text();
    assert.match(html, /<form/i);
    assert.match(html, /id="prompt"/); // the required prompt control
    assert.match(html, /dev \/ test tool/i); // clearly labeled a dev/test tool
    assert.equal(mock.submitted.length, 0); // serving the page never touches ComfyUI
  } finally {
    await svc.close();
  }
});

test("GET /index.html -> 200 text/html (same page)", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock);
  try {
    const res = await fetch(`${svc.base}/index.html`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
    const html = await res.text();
    assert.match(html, /<form/i);
  } finally {
    await svc.close();
  }
});

test("GET / -> served ungated even when auth is enabled (no token needed for the page)", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock, AUTH_CONFIG);
  try {
    const res = await fetch(`${svc.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  } finally {
    await svc.close();
  }
});

test("auth disabled (default) -> /generate open without a token", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock); // default CONFIG has auth disabled
  try {
    const res = await fetch(`${svc.base}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a castle" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
  } finally {
    await svc.close();
  }
});

test("auth enabled -> /generate 401 with no Authorization header", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock, AUTH_CONFIG);
  try {
    const res = await fetch(`${svc.base}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a castle" }),
    });
    assert.equal(res.status, 401);
    const body = (await res.json()) as any;
    assert.equal(body.error, "unauthorized"); // bare 401, no detail leaked
    assert.equal(mock.submitted.length, 0); // never reached ComfyUI
  } finally {
    await svc.close();
  }
});

test("auth enabled -> /generate 401 with a wrong token", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock, AUTH_CONFIG);
  try {
    const res = await fetch(`${svc.base}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
      body: JSON.stringify({ prompt: "a castle" }),
    });
    assert.equal(res.status, 401);
    assert.equal(mock.submitted.length, 0);
  } finally {
    await svc.close();
  }
});

test("auth enabled -> /generate 200 with the correct bearer token", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock, AUTH_CONFIG);
  try {
    const res = await fetch(`${svc.base}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer s3cret-token" },
      body: JSON.stringify({ prompt: "a castle", style: "oil painting" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, mock.bytesFor("pid-1"));
  } finally {
    await svc.close();
  }
});

test("auth enabled -> /styles 401 without token, 200 with token", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock, AUTH_CONFIG);
  try {
    const unauth = await fetch(`${svc.base}/styles`);
    assert.equal(unauth.status, 401);

    const ok = await fetch(`${svc.base}/styles`, {
      headers: { authorization: "Bearer s3cret-token" },
    });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as any;
    assert.ok(Array.isArray(body.styles));
  } finally {
    await svc.close();
  }
});

test("auth enabled -> /health stays open with no token", async () => {
  const mock = new MockComfy();
  const svc = await startService(mock, AUTH_CONFIG);
  try {
    const res = await fetch(`${svc.base}/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.comfyuiReachable, true);
  } finally {
    await svc.close();
  }
});

test("auth enabled but token unset -> fails closed (401 even with a bearer header)", async () => {
  const mock = new MockComfy();
  const misconfigured: Config = {
    comfyui: { url: "http://localhost:8188" },
    server: { host: "127.0.0.1", port: 0 },
    auth: { enabled: true, token: "" },
  };
  const svc = await startService(mock, misconfigured);
  try {
    const res = await fetch(`${svc.base}/generate`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " },
      body: JSON.stringify({ prompt: "a castle" }),
    });
    assert.equal(res.status, 401);
    assert.equal(mock.submitted.length, 0);
  } finally {
    await svc.close();
  }
});
