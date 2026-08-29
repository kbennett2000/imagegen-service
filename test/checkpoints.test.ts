import assert from "node:assert/strict";
import { test } from "node:test";

import { CHECKPOINTS, lookupCheckpoint, resolveCheckpoint } from "../src/checkpoints.ts";

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
