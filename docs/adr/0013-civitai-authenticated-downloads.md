# ADR-0013: Civitai-authenticated model downloads

## Status
Accepted

## Context
The installers ([install/install-linux.sh](../../install/install-linux.sh),
[install/install-windows.ps1](../../install/install-windows.ps1)) download every model file listed in
[install/models.manifest](../../install/models.manifest) — SDXL base/refiner/VAE and the style LoRAs —
into ComfyUI's model dirs. The manifest already lists a handful of
`https://civitai.com/api/download/models/<versionId>` URLs as the primary source for some LoRAs
(ADR-0003), but the download path sends **no authentication**. Civitai's download endpoints are
frequently login-gated: an unauthenticated request returns an HTML login page, which fails the
existing safetensors verification, falls through to the ungated Hugging Face mirror, and — where no
mirror exists — the style degrades to prompt-only.

To broaden the catalog with a wide variety of SFW checkpoints, LoRAs, and video models (ADR-0014,
ADR-0015), many of which live only behind Civitai's gate, the download path needs to authenticate
with a user-supplied Civitai API key. This ADR adds that, as the foundation the catalog slices build
on. It changes nothing about the running service — the token is a download-time secret only.

## Decision

### A download-time secret, never in `src/`
The Civitai API key is used ONLY while fetching model files (the installers and the `scripts/` fetch
helpers). It is never read by the running service. The `src/` no-env invariant (ADR-0001) is
untouched: `grep -rn "process.env" src/` stays empty. The TS fetch helpers read the token from a
**file**, not `process.env`, keeping the same file-config discipline; the shell installer additionally
honors a `CIVITAI_TOKEN` env var, which is acceptable for a shell entry point.

### Three sources, one precedence
The token resolves from, in order:
1. `--civitai-token <key>` (Linux) / `-CivitaiToken <key>` (Windows) — an explicit flag.
2. a `CIVITAI_TOKEN` environment variable (installers only).
3. `install/secrets.env` — a gitignored `KEY=VALUE` file (`CIVITAI_TOKEN=…`), with a committed
   [install/secrets.env.example](../../install/secrets.env.example) template. Added to
   [.gitignore](../../.gitignore) so a real key never lands in git.

This mirrors how the runtime already prefers `config.json` (gitignored) over
`config.example.json` (committed) — the "gitignored file, committed template" pattern, applied to a
secret.

### Bearer header, civitai.com only
When a URL's host is `civitai.com` (or a subdomain) **and** a token is set, the download attaches
`Authorization: Bearer <token>`. For every other host — Hugging Face, any mirror — no header is
attached, so the token can never leak off Civitai. Host-matching is exact (a look-alike like
`civitai.com.evil.example` does not match); the shared TS helper
([scripts/lib/civitai.ts](../../scripts/lib/civitai.ts)) parses the URL and checks the hostname, and
the shell/PowerShell paths use equivalently-anchored patterns.

### Shared, tested helper
[scripts/lib/civitai.ts](../../scripts/lib/civitai.ts) exposes `parseCivitaiToken`,
`readCivitaiTokenFile`, `resolveCivitaiToken`, `isCivitaiUrl`, and `civitaiCurlArgs` — pure functions
unit-tested without a filesystem or network ([test/civitai.test.ts](../../test/civitai.test.ts)).
[scripts/fetch-wan22-models.ts](../../scripts/fetch-wan22-models.ts) is wired to use it (a no-op for
its Hugging Face URLs, but ready for a Civitai-sourced mirror), and future fetch scripts (ADR-0015)
reuse it. The installers keep the same behavior in bash/PowerShell.

### No new dependency
The download still shells out to `curl` (with `wget`/`Invoke-WebRequest` fallbacks) — the header is
one more argument. `package.json` gains no runtime `dependencies` (consistent with ADR-0010).

## Consequences
- **Gated Civitai models become installable** with a key, unlocking the broader catalog in ADR-0014/
  ADR-0015. Without a key, behavior is exactly as before: HF mirror, else prompt-only degrade.
- **The key stays out of git and out of the service.** It lives in a gitignored file (or a flag/env),
  is used only for civitai.com, and the running service never sees it.
- **The existing verify→fallback→warn-and-continue contract is unchanged.** Auth only improves the
  odds the primary Civitai source succeeds; every other guarantee (size + safetensors-header check,
  mirror fallback, non-fatal skip) is intact.
- **Cross-platform parity.** Linux and Windows resolve the token the same way and attach the header
  the same way; only the shell idioms differ.
