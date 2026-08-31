import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { Config } from "../src/config.ts";
import { flockProvider, type AcquireResult, type LockProvider } from "../src/gpu-lease.ts";
import { createServer, type ServerDeps } from "../src/server.ts";
import { MockComfy } from "./helpers/mock-comfy.ts";

const B64_STILL = Buffer.from("fake-png-bytes").toString("base64");

// Small idle grace so a drained batch frees+releases in well under a test's patience.
function config(overrides: Partial<Config["gpuLock"]> = {}): Config {
  return {
    comfyui: { url: "http://localhost:8188", checkpoint: "", upscaleModel: "" },
    server: { host: "127.0.0.1", port: 0 },
    auth: { enabled: false, token: "" },
    gpuLock: {
      path: "/unused-in-tests.lock",
      maxHoldMs: 1_260_000,
      idleGraceMs: 20,
      acquireTimeoutMs: 1_000,
      enabled: true,
      ...overrides,
    },
  };
}

// A fake advisory lock: no filesystem, no flock. Records acquire/release order (optionally into a
// shared event log so a test can assert free-before-release across the lock and the /free HTTP call).
class FakeLock implements LockProvider {
  acquires = 0;
  releases = 0;
  constructor(
    private readonly events: string[] = [],
    private readonly failReason: string | null = null,
  ) {}
  async acquire(): Promise<AcquireResult> {
    this.acquires += 1;
    if (this.failReason) return { ok: false, reason: this.failReason };
    return {
      ok: true,
      handle: {
        release: async () => {
          this.releases += 1;
          this.events.push("release");
        },
      },
    };
  }
}

async function startService(
  mock: MockComfy,
  deps: ServerDeps,
  cfg: Config = config(),
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer(cfg, mock.fetch, deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timed out");
}

function generate(base: string, prompt: string): Promise<globalThis.Response> {
  return fetch(`${base}/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

// ---- held-while-busy refcount: one lease per batch, ONE /free (not per request) ----------------

test("two overlapping /generate acquire the lock once and free ComfyUI once", async () => {
  // Both jobs stay in flight for a couple of polls, guaranteeing they overlap under one lease.
  const mock = new MockComfy({ readyAfterPolls: () => 2 });
  const lock = new FakeLock();
  const svc = await startService(mock, { lockProvider: lock });
  try {
    const [a, b] = await Promise.all([generate(svc.base, "one"), generate(svc.base, "two")]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(mock.submitted.length, 2); // both drained through ComfyUI
    // Held across both jobs: acquired exactly once, no per-request free while busy.
    assert.equal(lock.acquires, 1);
    // After the batch drains + idle grace: exactly one free, then one release.
    await waitFor(() => lock.releases === 1);
    assert.equal(mock.freeCalls, 1);
    assert.equal(lock.releases, 1);
  } finally {
    await svc.close();
  }
});

// ---- free-before-release ordering (the cross-service contract) ---------------------------------

test("ComfyUI /free is POSTed BEFORE the flock is released", async () => {
  const events: string[] = [];
  const mock = new MockComfy();
  mock.onFree = () => events.push("free");
  const lock = new FakeLock(events);
  const svc = await startService(mock, { lockProvider: lock });
  try {
    assert.equal((await generate(svc.base, "solo")).status, 200);
    await waitFor(() => events.length >= 2);
    assert.deepEqual(events, ["free", "release"]);
  } finally {
    await svc.close();
  }
});

// ---- /stitch is CPU/ffmpeg — must NOT be gated by the GPU lease --------------------------------

test("/stitch never touches the GPU lease", async () => {
  const mock = new MockComfy();
  const lock = new FakeLock();
  const svc = await startService(mock, {
    lockProvider: lock,
    stitchVideos: async () => ({ ok: true as const, bytes: Buffer.from("JOINED") }),
    ffmpegAvailable: async () => true,
  });
  try {
    const clips = [Buffer.from("a").toString("base64"), Buffer.from("b").toString("base64")];
    const res = await fetch(`${svc.base}/stitch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clips }),
    });
    assert.equal(res.status, 200);
    // No lease activity at all: /stitch is off the GPU.
    assert.equal(lock.acquires, 0);
    assert.equal(mock.freeCalls, 0);
  } finally {
    await svc.close();
  }
});

test("/health does not acquire the GPU lease", async () => {
  const mock = new MockComfy();
  const lock = new FakeLock();
  const svc = await startService(mock, { lockProvider: lock, ffmpegAvailable: async () => true });
  try {
    assert.equal((await fetch(`${svc.base}/health`)).status, 200);
    assert.equal(lock.acquires, 0);
  } finally {
    await svc.close();
  }
});

// ---- fail-open: lock unavailable -> proceed WITHOUT the lock, never free -----------------------

test("a failing lock provider fails open: /generate still succeeds, ComfyUI is not freed", async () => {
  const mock = new MockComfy();
  const lock = new FakeLock([], "lockfile missing");
  const svc = await startService(mock, { lockProvider: lock });
  try {
    assert.equal((await generate(svc.base, "x")).status, 200);
    assert.equal(mock.submitted.length, 1); // work still ran
    assert.ok(lock.acquires >= 1); // it tried
    // We never held the lock, so we must NOT free the other tenant's/​shared VRAM.
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(mock.freeCalls, 0);
    assert.equal(lock.releases, 0);
  } finally {
    await svc.close();
  }
});

test("gpuLock.enabled=false bypasses the lease entirely", async () => {
  const mock = new MockComfy();
  const lock = new FakeLock();
  const svc = await startService(mock, { lockProvider: lock }, config({ enabled: false }));
  try {
    assert.equal((await generate(svc.base, "x")).status, 200);
    assert.equal(lock.acquires, 0);
    assert.equal(mock.freeCalls, 0);
  } finally {
    await svc.close();
  }
});

// ---- a long /animate holds the lease its whole duration, frees only after it drains ------------

test("a long /animate holds one lease, frees ComfyUI once only after it completes", async () => {
  const mock = new MockComfy({ readyAfterPolls: () => 3, outputFilename: (pid) => `${pid}.mp4` });
  const lock = new FakeLock();
  const svc = await startService(mock, { lockProvider: lock });
  try {
    const res = await fetch(`${svc.base}/animate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "come alive", image: B64_STILL }),
    });
    assert.equal(res.status, 200);
    // At the moment the render returns, ComfyUI has NOT been freed yet (free is post-drain, not
    // mid-job) — proving the lease was held for the whole job, not released between polls.
    assert.equal(mock.freeCalls, 0);
    assert.equal(lock.acquires, 1);
    await waitFor(() => lock.releases === 1);
    assert.equal(mock.freeCalls, 1);
  } finally {
    await svc.close();
  }
});

// ---- real flock(1) smoke test (skipped where flock isn't installed) ----------------------------

const HAS_FLOCK = spawnSync("flock", ["--version"]).status === 0;

test("real flock(1) mutually excludes and releases", { skip: !HAS_FLOCK }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "gpu-lock-"));
  const lockPath = path.join(dir, "gpu-tenant.lock");
  const provider = flockProvider(lockPath);

  const first = await provider.acquire(60_000);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  // A second waiter can't get it while the first holds it (bounded ~1s wait -> acquire-timeout).
  const blocked = await provider.acquire(1_000);
  assert.equal(blocked.ok, false);

  // Release the first; now a fresh acquire succeeds.
  await first.handle.release();
  const second = await provider.acquire(60_000);
  assert.equal(second.ok, true);
  if (second.ok) await second.handle.release();
});
