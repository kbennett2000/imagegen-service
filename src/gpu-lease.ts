// Shared-flock GPU tenancy lease (ADR-0012). One advisory file lock (flock) that this service and
// text-transform-service both honor: whoever holds it owns the whole GPU, drains its queued work
// under one lease (hold-and-drain), frees its own VRAM, then releases. This module is this service's
// half. It sits AROUND the GPU-touching engine calls (generateImage / animateImage) in the server
// handlers — it does not replace the per-request prompt_id isolation inside the engine.
//
// Design notes:
//  - Refcounted, NOT per-request. A burst of /generate acquires the lock once (0->1), holds while any
//    job is in flight, and frees ComfyUI once after the last one drains — so the checkpoint reloads at
//    most once per batch.
//  - free-before-release. On going idle we POST ComfyUI /free (drop the checkpoint) and ONLY THEN drop
//    the flock, so the next tenant finds clear VRAM (ADR-0012 / the shared spec's ordering contract).
//  - Non-preemptive MAX_HOLD. A running job is never interrupted; maxHoldMs only decides whether, once
//    idle, we yield promptly instead of bridging the idle grace. Sized above a full Wan render so a
//    video never self-yields.
//  - Fail-open. If the lock can't be taken (missing/​unlockable file, acquire timeout) we log and
//    proceed WITHOUT the lock — the lock is a throughput optimization, not a safety gate.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import { freeComfy, type FetchFn } from "./engine.js";

// ---- lock provider abstraction -----------------------------------------------------------------
// Injectable so tests drive the lease with a fake in-memory lock (no filesystem, no real flock).

export interface LockHandle {
  // Release the lock. Resolves once the kernel has dropped it (the flock child has exited).
  release(): Promise<void>;
}

export type AcquireResult =
  | { ok: true; handle: LockHandle }
  | { ok: false; reason: string };

export interface LockProvider {
  // Block until the lock is held or `timeoutMs` elapses. Never throws: any failure returns
  // { ok:false, reason } so the lease can fail open.
  acquire(timeoutMs: number): Promise<AcquireResult>;
}

// Real advisory lock via flock(1) — no npm dependency (a system tool, like ffmpeg/curl per ADR-0010).
// A long-lived child holds the lock fd for its whole lifetime:
//   flock -w <secs> -x <path> -c 'printf R; exec cat'
// flock takes LOCK_EX, then runs the command, which prints "R" (=> acquired) and then `cat` blocks on
// stdin. Closing the child's stdin makes cat hit EOF and exit, flock exits, the kernel drops the lock.
// Crash-safety is free: if THIS process dies (even SIGKILL) the kernel closes the pipe's write end ->
// cat EOF -> the same release chain runs. That is why the child reads our pipe rather than sleeping.
export function flockProvider(lockPath: string): LockProvider {
  return {
    acquire(timeoutMs: number): Promise<AcquireResult> {
      return new Promise<AcquireResult>((resolve) => {
        const timeoutSecs = Math.max(1, Math.ceil(timeoutMs / 1000));
        let settled = false;
        const settle = (r: AcquireResult): void => {
          if (settled) return;
          settled = true;
          resolve(r);
        };

        let child: ReturnType<typeof spawn>;
        try {
          child = spawn(
            "flock",
            ["-w", String(timeoutSecs), "-x", lockPath, "-c", "printf R; exec cat"],
            { stdio: ["pipe", "pipe", "ignore"] },
          );
        } catch (err) {
          settle({ ok: false, reason: `spawn flock failed: ${err instanceof Error ? err.message : String(err)}` });
          return;
        }

        // flock binary missing / not executable, etc.
        child.on("error", (err) => settle({ ok: false, reason: `flock unavailable: ${err.message}` }));

        // "R" on stdout => we hold the lock. Hand back a handle that releases by closing stdin.
        child.stdout?.on("data", (buf: Buffer) => {
          if (!buf.includes(0x52 /* 'R' */)) return;
          settle({
            ok: true,
            handle: {
              release(): Promise<void> {
                return new Promise<void>((res) => {
                  let done = false;
                  const finish = (): void => {
                    if (done) return;
                    done = true;
                    clearTimeout(kill);
                    res();
                  };
                  child.once("exit", finish);
                  // Belt-and-suspenders: if EOF doesn't unwind the child promptly, kill it — the kernel
                  // still drops the lock on death.
                  const kill = setTimeout(() => {
                    try { child.kill("SIGKILL"); } catch { /* already gone */ }
                  }, 2000);
                  try { child.stdin?.end(); } catch { /* already gone */ }
                });
              },
            },
          });
        });

        // Exited before we ever saw "R" => never acquired. -w timeout is exit code 1.
        child.on("exit", (code) => {
          const reason =
            code === 1 ? `acquire-timeout after ${timeoutSecs}s` : `flock exited (code ${code}) before acquiring`;
          settle({ ok: false, reason });
        });
      });
    },
  };
}

// ---- the lease ---------------------------------------------------------------------------------

export interface GpuLeaseOptions {
  enabled: boolean;
  path: string;
  maxHoldMs: number;
  idleGraceMs: number;
  acquireTimeoutMs: number;
  comfyUrl: string;
  fetchFn: FetchFn;
  // Injected in tests; defaults to the real flock(1)-backed provider.
  provider?: LockProvider;
  // Injected in tests to observe log lines; defaults to console.
  logger?: (line: string) => void;
}

function shortId(): string {
  return randomBytes(3).toString("hex");
}

export class GpuLease {
  private readonly enabled: boolean;
  private readonly maxHoldMs: number;
  private readonly idleGraceMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly comfyUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly provider: LockProvider;
  private readonly logger: (line: string) => void;

  // in-flight GPU jobs currently holding the lease busy
  private refcount = 0;
  private held: LockHandle | null = null;
  // shared across concurrent enters so a burst acquires exactly once
  private acquireInFlight: Promise<void> | null = null;
  // set when the current acquire failed and we're serving the batch fail-open (no lock)
  private failedOpen = false;
  // pending idle-grace timer, and the in-progress free+release
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private releaseInFlight: Promise<void> | null = null;
  private acquiredAt = 0;
  private drained = 0; // jobs served under the current lease
  private leaseId = "";

  constructor(opts: GpuLeaseOptions) {
    this.enabled = opts.enabled;
    this.maxHoldMs = opts.maxHoldMs;
    this.idleGraceMs = opts.idleGraceMs;
    this.acquireTimeoutMs = opts.acquireTimeoutMs;
    this.comfyUrl = opts.comfyUrl;
    this.fetchFn = opts.fetchFn;
    this.provider = opts.provider ?? flockProvider(opts.path);
    this.logger = opts.logger ?? ((line) => console.log(line));
  }

  // Run one GPU job under the shared lease. Acquires on 0->1, holds while busy, frees+releases after
  // the batch drains (idleGraceMs later, or promptly past maxHoldMs). fn is the engine call; its
  // result (including its never-throw error shape) is passed straight through.
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.enabled) return fn();
    await this.enter();
    this.drained++;
    try {
      return await fn();
    } finally {
      this.refcount--;
      if (this.refcount === 0) this.onIdle();
    }
  }

  private async enter(): Promise<void> {
    this.refcount++;
    // A fresh job cancels a pending idle release — we keep holding (hold-and-drain).
    if (this.releaseTimer) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
    }
    // If a free+release already began, let it finish, then acquire the lock anew (back of the line).
    while (this.releaseInFlight) await this.releaseInFlight;
    // Already holding, or already serving this batch fail-open: nothing more to do.
    if (this.held || this.failedOpen) return;
    if (!this.acquireInFlight) this.acquireInFlight = this.doAcquire();
    await this.acquireInFlight;
  }

  private async doAcquire(): Promise<void> {
    try {
      const result = await this.provider.acquire(this.acquireTimeoutMs);
      if (result.ok) {
        this.held = result.handle;
        this.acquiredAt = Date.now();
        this.drained = 0;
        this.leaseId = shortId();
        this.log("acquired");
      } else {
        this.failedOpen = true;
        this.log(`fail-open (${result.reason})`);
      }
    } catch (err) {
      // A provider should never throw, but treat it as fail-open if it does.
      this.failedOpen = true;
      this.log(`fail-open (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  private onIdle(): void {
    if (this.held) {
      this.scheduleRelease();
      return;
    }
    // Fail-open batch drained (we never held the lock): reset so the NEXT batch retries acquiring.
    this.acquireInFlight = null;
    this.failedOpen = false;
  }

  private scheduleRelease(): void {
    if (this.refcount !== 0 || !this.held || this.releaseTimer || this.releaseInFlight) return;
    // Past maxHoldMs => yield promptly to give the peer tenant a turn; else bridge the idle grace so a
    // near-immediate follow-up (e.g. generate->animate) reuses the warm checkpoint.
    const overHold = Date.now() - this.acquiredAt >= this.maxHoldMs;
    const delay = overHold ? 0 : this.idleGraceMs;
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null;
      if (this.refcount !== 0 || !this.held) return; // work arrived during the grace window
      this.releaseInFlight = this.doRelease();
    }, delay);
  }

  private async doRelease(): Promise<void> {
    const handle = this.held;
    const n = this.drained;
    try {
      this.log(`drained ${n} job(s)`);
      // free BEFORE release so the waiter finds clear VRAM (ordering is the cross-service contract).
      const freed = await freeComfy(this.comfyUrl, this.fetchFn);
      this.log(`freed comfyui (${freed ? "ok" : "failed"})`);
      await handle?.release();
      this.log("released");
    } finally {
      this.held = null;
      this.acquireInFlight = null;
      this.failedOpen = false;
      this.drained = 0;
      this.releaseInFlight = null;
    }
  }

  private log(msg: string): void {
    this.logger(`[gpu-lock] ${this.leaseId || "----"} ${msg}`);
  }
}
