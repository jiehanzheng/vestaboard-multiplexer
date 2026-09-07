import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigStore, DEFAULT_APP_CONFIG } from "../src/config.js";
import { ConfigPatchSchema } from "../src/contracts/config.js";

test("migrates older Codex configs to automatic duration labels", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-codex-labels-"));
  try {
    const { window1Label: _window1Label, window2Label: _window2Label, ...oldCodex } = DEFAULT_APP_CONFIG.codex;
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, "config.json"), JSON.stringify({ version: 1, ...DEFAULT_APP_CONFIG, codex: oldCodex }));
    const store = await ConfigStore.open(dataDir, {});
    assert.equal(store.get().codex.window1Label, null);
    assert.equal(store.get().codex.window2Label, null);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("validates Codex labels and preserves omitted labels in partial patches", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-codex-label-patch-"));
  try {
    const store = await ConfigStore.open(dataDir, {});
    await store.save({ ...DEFAULT_APP_CONFIG, codex: { ...DEFAULT_APP_CONFIG.codex, window1Label: "F", window2Label: "W2" } });
    assert.deepEqual(ConfigPatchSchema.parse({ codex: { showPacing: false } }).codex, { showPacing: false });
    await store.save(ConfigPatchSchema.parse({ codex: { showPacing: false } }));
    assert.equal(store.get().codex.window1Label, "F");
    await assert.rejects(store.save({ codex: { window1Label: "bad" } }), /window1Label.*1 or 2|uppercase/i);
    await assert.rejects(store.save({ codex: { window1Label: "*" } }), /window1Label.*supported/i);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("saves supported one-character labels without changing calculated defaults", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-codex-label-default-"));
  try {
    const store = await ConfigStore.open(dataDir, {});
    await store.save(ConfigPatchSchema.parse({ codex: { window1Label: "5", window2Label: null } }));
    assert.equal(store.get().codex.window1Label, "5");
    assert.equal(store.get().codex.window2Label, null);
    assert.match(JSON.parse(await readFile(join(dataDir, "config.json"), "utf8")).codex.window1Label, /^5$/);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});
