import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CHECKPOINTS,
  checkpointBasename,
  checkpointInstalled,
  lookupCheckpoint,
  reconcileCheckpoint,
  resolveCheckpoint,
} from "../src/checkpoints.ts";

test("resolveCheckpoint: an empty/absent value resolves to undefined (keep template default)", () => {
  assert.equal(resolveCheckpoint(undefined), undefined);
  assert.equal(resolveCheckpoint(null), undefined);
  assert.equal(resolveCheckpoint(""), undefined);
  assert.equal(resolveCheckpoint("   "), undefined);
});

test("resolveCheckpoint: an unknown name (e.g. a raw filename) passes through unchanged", () => {
  assert.equal(resolveCheckpoint("sd_xl_base_1.0.safetensors"), "sd_xl_base_1.0.safetensors");
  assert.equal(resolveCheckpoint("some-custom-model.safetensors"), "some-custom-model.safetensors");
});

test("resolveCheckpoint: a catalog name maps to its file, case-insensitively", () => {
  for (const [name, info] of Object.entries(CHECKPOINTS)) {
    assert.equal(resolveCheckpoint(name), info.file);
    assert.equal(resolveCheckpoint(name.toUpperCase()), info.file);
    assert.equal(resolveCheckpoint(`  ${name}  `), info.file);
  }
});

test("lookupCheckpoint: catalog entries are well-formed (name/file/description present)", () => {
  const files = new Set<string>();
  for (const [name, info] of Object.entries(CHECKPOINTS)) {
    assert.equal(name, name.trim().toLowerCase(), `key "${name}" must be normalized`);
    assert.ok(info.file.endsWith(".safetensors"), `${name}: file must be a .safetensors`);
    assert.ok(info.description.length > 0, `${name}: needs a description`);
    assert.ok(!files.has(info.file), `duplicate file ${info.file}`);
    files.add(info.file);
    assert.deepEqual(lookupCheckpoint(name), info);
  }
});

test("lookupCheckpoint: unknown names return undefined", () => {
  assert.equal(lookupCheckpoint("definitely-not-a-catalog-name"), undefined);
  assert.equal(lookupCheckpoint(""), undefined);
});

// --- subfolder reconciliation (ADR-0019) --------------------------------------------------

test("checkpointBasename: strips a forward-slash subfolder prefix, leaves bare names alone", () => {
  assert.equal(checkpointBasename("sub/foo.safetensors"), "foo.safetensors");
  assert.equal(checkpointBasename("a/b/deep.safetensors"), "deep.safetensors");
  assert.equal(checkpointBasename("foo.safetensors"), "foo.safetensors");
  assert.equal(checkpointBasename(""), "");
});

test("checkpointInstalled: matches by basename so a subfoldered install counts", () => {
  const available = ["sub/animagine-xl-3.1.safetensors", "alt/other.safetensors"];
  assert.equal(checkpointInstalled("animagine-xl-3.1.safetensors", available), true);
  assert.equal(checkpointInstalled("other.safetensors", available), true);
  assert.equal(checkpointInstalled("not-there.safetensors", available), false);
  // A bare install still matches a bare catalog file (the flat, no-subfolder case).
  assert.equal(checkpointInstalled("flat.safetensors", ["flat.safetensors"]), true);
});

test("reconcileCheckpoint: exact match wins, else basename match recovers the prefix", () => {
  const available = ["sub/sd_xl_base_1.0.safetensors", "alt/other.safetensors"];
  // Bare desired -> the subfoldered name ComfyUI actually reports.
  assert.equal(reconcileCheckpoint("sd_xl_base_1.0.safetensors", available), "sub/sd_xl_base_1.0.safetensors");
  // An exact hit is returned untouched.
  assert.equal(reconcileCheckpoint("sub/sd_xl_base_1.0.safetensors", available), "sub/sd_xl_base_1.0.safetensors");
});

test("reconcileCheckpoint: unknown or unlistable -> desired unchanged (ComfyUI errors cleanly)", () => {
  assert.equal(reconcileCheckpoint("missing.safetensors", ["sub/foo.safetensors"]), "missing.safetensors");
  assert.equal(reconcileCheckpoint("foo.safetensors", []), "foo.safetensors");
  // Flat install: bare desired already matches exactly, no prefix invented.
  assert.equal(reconcileCheckpoint("foo.safetensors", ["foo.safetensors"]), "foo.safetensors");
});
