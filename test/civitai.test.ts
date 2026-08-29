import assert from "node:assert/strict";
import { test } from "node:test";

import {
  civitaiCurlArgs,
  isCivitaiUrl,
  parseCivitaiToken,
  resolveCivitaiToken,
} from "../scripts/lib/civitai.ts";

test("parseCivitaiToken: reads a plain KEY=VALUE line", () => {
  assert.equal(parseCivitaiToken("# comment\n\nCIVITAI_TOKEN=abc123\n"), "abc123");
});

test("parseCivitaiToken: strips one pair of surrounding quotes", () => {
  assert.equal(parseCivitaiToken('CIVITAI_TOKEN="q u o t e d"'), "q u o t e d");
  assert.equal(parseCivitaiToken("CIVITAI_TOKEN='single'"), "single");
});

test("parseCivitaiToken: tolerates surrounding whitespace and CRLF", () => {
  assert.equal(parseCivitaiToken("  CIVITAI_TOKEN =  spaced  \r\n"), "spaced");
});

test("parseCivitaiToken: a commented-out token is not read", () => {
  assert.equal(parseCivitaiToken("# CIVITAI_TOKEN=nope\nOTHER=x\n"), "");
});

test("parseCivitaiToken: missing key yields empty string", () => {
  assert.equal(parseCivitaiToken("FOO=bar\nBAZ=qux\n"), "");
});

test("resolveCivitaiToken: an explicit override wins over the file", () => {
  // repoRoot points nowhere real, so the file branch would return "" — the override must be used.
  assert.equal(resolveCivitaiToken("/no/such/repo", "  overridden  "), "overridden");
});

test("resolveCivitaiToken: no override and no file yields empty string", () => {
  assert.equal(resolveCivitaiToken("/no/such/repo", ""), "");
  assert.equal(resolveCivitaiToken("/no/such/repo", null), "");
});

test("isCivitaiUrl: true only for civitai.com and its subdomains", () => {
  assert.equal(isCivitaiUrl("https://civitai.com/api/download/models/123"), true);
  assert.equal(isCivitaiUrl("https://cdn.civitai.com/x"), true);
  assert.equal(isCivitaiUrl("https://huggingface.co/foo/bar.safetensors"), false);
  // Look-alike host that merely starts with civitai.com must NOT match.
  assert.equal(isCivitaiUrl("https://civitai.com.evil.test/x"), false);
  assert.equal(isCivitaiUrl("not a url"), false);
});

test("civitaiCurlArgs: adds the Bearer header ONLY for civitai.com with a token", () => {
  assert.deepEqual(civitaiCurlArgs("https://civitai.com/api/download/models/1", "tok"), [
    "-H",
    "Authorization: Bearer tok",
  ]);
  // No token -> no header, even for civitai.
  assert.deepEqual(civitaiCurlArgs("https://civitai.com/api/download/models/1", ""), []);
  // Token present but a non-civitai host -> never leak it.
  assert.deepEqual(civitaiCurlArgs("https://huggingface.co/foo.safetensors", "tok"), []);
});
