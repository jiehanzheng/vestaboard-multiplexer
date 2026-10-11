import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHABlockIntegration } from "../src/plugins/haBlock.js";
import { DEFAULT_HA_BLOCK_CONFIG, HABlockConfigSchema, HA_BLOCK_ELEMENT_ID, type HABlockConfig } from "../src/plugins/haBlock/config.js";
import type { HomeAssistantSnapshot, HomeAssistantSnapshotListener } from "../src/homeAssistantService.js";
import { composeElements } from "../src/elements.js";
import { ConfigStore, DEFAULT_APP_CONFIG } from "../src/config.js";
import { configPatchForSection, reconcileSectionSave, replaceSection, sectionIsDirty, updateHABlockDraft } from "../web/src/draftState.js";

const active: HABlockConfig = { ...DEFAULT_HA_BLOCK_CONFIG, enabled: true, entityId: "sensor.block" };
function fixture(config: HABlockConfig = active) {
  let time = 0;
  let snapshot: HomeAssistantSnapshot = { source: "http://ha.test", connected: true,
    entities: [{ entity_id: "sensor.block", state: "ready", attributes: { characters: [68, 10, 26] }, last_updated: "2000-01-01T00:00:00Z" }] };
  const listeners = new Set<HomeAssistantSnapshotListener>();
  let changes = 0;
  const plugin = createHABlockIntegration(config, { snapshot: () => snapshot, subscribe(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; } }, () => { changes++; }, { info() {}, warn() {} }, () => new Date(time));
  return { plugin, listeners, changes: () => changes, now: (value: number) => { time = value; },
    emit(patch: Partial<HomeAssistantSnapshot>) { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(snapshot); },
    payload(characters: unknown, state = "ready", extra = {}) {
      this.emit({ entities: [{ entity_id: "sensor.block", state, attributes: { characters, ...extra } }] });
    }, row: () => plugin.elements()[0]!.render(config.width) };
}

test("HA badges update from attribute-only events; valid zeros and unchanged paused content stay healthy", () => {
  const f = fixture();
  for (const badge of [[68, 10, 26], [69, 10, 26], [68, 25, 13], [69, 25, 13], [0, 0, 0]]) {
    f.payload(badge);
    assert.deepEqual(f.row(), [badge]);
    assert.equal(f.plugin.status().error, undefined);
  }
  f.payload([69, 25, 13]); f.now(24 * 60 * 60_000);
  assert.deepEqual(f.row(), [[69, 25, 13]]);
  assert.equal(f.plugin.status().stale, false);
  assert.equal(f.changes(), 7);
  f.plugin.stop(); assert.equal(f.listeners.size, 0);
});

test("invalid or oversized arrays render the entire configured fallback without truncation or coercion", () => {
  const f = fixture();
  for (const invalid of [undefined, null, [], "[68,10,26]", [true, 10, 26], [68.1, 10, 26], [43, 10, 26], [71, 10, 26], [-1], [[68, 10, 26]], [68, 10, 26, 1]]) {
    f.payload(invalid); assert.deepEqual(f.row(), [[14, 59, 1]]); assert.ok(f.plugin.status().error);
  }
  f.plugin.configure({ ...active, unavailableDisplay: "blank" });
  assert.deepEqual(f.row(), [[0, 0, 0]]);
});

test("missing, restored, non-ready and disconnected sources fail immediately; staleness marks duration and recovery resets it", () => {
  const f = fixture();
  f.emit({ connected: false }); assert.deepEqual(f.row(), [[14, 59, 1]]);
  assert.equal(f.plugin.status().unavailableSince, new Date(0).toISOString());
  f.now(15 * 60_000 - 1); assert.equal(f.plugin.status().stale, false);
  f.now(15 * 60_000); assert.equal(f.plugin.status().stale, true);
  f.plugin.configure({ ...active, staleAfterMinutes: null }); assert.equal(f.plugin.status().stale, false);
  f.emit({ connected: true }); assert.deepEqual(f.row(), [[68, 10, 26]]);
  assert.equal(f.plugin.status().unavailableSince, undefined);
  for (const state of ["unknown", "unavailable", "playing", ""]) {
    f.payload([68, 10, 26], state); assert.deepEqual(f.row(), [[14, 59, 1]]);
  }
  f.payload([68, 10, 26], "ready", { restored: true }); assert.deepEqual(f.row(), [[14, 59, 1]]);
  f.emit({ entities: [] }); assert.deepEqual(f.row(), [[14, 59, 1]]);
  f.now(20 * 60_000);
  f.emit({ source: "http://other-ha.test" });
  assert.equal(f.plugin.status().unavailableSince, new Date(20 * 60_000).toISOString());
  f.now(21 * 60_000); f.plugin.configure({ ...active, entityId: "sensor.other" });
  assert.equal(f.plugin.status().unavailableSince, new Date(21 * 60_000).toISOString());
  f.plugin.configure({ ...active, enabled: false }); assert.deepEqual(f.row(), [[0, 0, 0]]);
  assert.equal(f.plugin.status().error, undefined);
});

test("generic dimensions fill row-major, pad opaque blanks, and keep draft previews isolated", () => {
  const config: HABlockConfig = { ...active, width: 4, height: 2 };
  const f = fixture(config);
  f.payload([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(f.plugin.elements()[0]!.render(5), [[1, 2, 3, 4, 0], [5, 6, 7, 8, 0]]);
  f.payload([1, 2, 3, 4, 5]); assert.deepEqual(f.row(), [[1, 2, 3, 4], [5, 0, 0, 0]]);
  const draft = { ...config, width: 1, height: 3, unavailableDisplay: "blank" as const };
  f.payload([69, 25, 13]);
  assert.deepEqual(f.plugin.elements(draft)[0]!.render(1), [[69], [25], [13]]);
  assert.deepEqual(f.row(), [[69, 25, 13, 0], [0, 0, 0, 0]]);
  f.payload([1, 2, 3, 4, 5, 6, 7, 8, 9]); assert.deepEqual(f.row(), [[14, 59, 1, 0], [0, 0, 0, 0]]);
  assert.throws(() => f.plugin.elements()[0]!.render(3), /at least 4/);
  assert.equal(HABlockConfigSchema.safeParse({ ...active, width: 2, height: 3 }).success, false);
  assert.equal(HABlockConfigSchema.safeParse({ ...active, width: 2, height: 3, unavailableDisplay: "blank" }).success, true);
});

test("composition checks both board sizes and resized block overlap before producing output", () => {
  const f = fixture();
  const layout = [{ elementId: HA_BLOCK_ELEMENT_ID, startRow: 2, startColumn: 12, width: 3 }];
  assert.deepEqual(composeElements(f.plugin.elements(), layout, { width: 15, height: 3 }).characters[2]!.slice(12), [68, 10, 26]);
  assert.throws(() => composeElements(f.plugin.elements({ ...active, height: 2 }), layout, { width: 15, height: 3 }), /out of bounds/);
  assert.throws(() => composeElements(f.plugin.elements(), [...layout, ...layout], { width: 15, height: 3 }), /overlaps/);
  assert.throws(() => composeElements(f.plugin.elements(), [{ ...layout[0]!, startColumn: 13 }], { width: 15, height: 3 }), /out of bounds/);
  assert.deepEqual(composeElements(f.plugin.elements(), [{ ...layout[0]!, startRow: 5, startColumn: 19 }], { width: 22, height: 6 }, "flagship").characters[5]!.slice(19), [68, 10, 26]);
});

test("old config gets disabled defaults and partial patches preserve custom dimensions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ha-block-config-"));
  try {
    const store = await ConfigStore.open(directory, {});
    assert.deepEqual(store.get().haBlock, DEFAULT_HA_BLOCK_CONFIG);
    await store.save({ haBlock: { width: 4, height: 2, unavailableDisplay: "blank" } });
    await store.save({ haBlock: { staleAfterMinutes: null } });
    assert.equal(store.get().haBlock.width, 4); assert.equal(store.get().haBlock.height, 2);
    assert.equal(store.get().haBlock.unavailableDisplay, "blank");
    const old = JSON.parse(await readFile(join(directory, "config.json"), "utf8")); delete old.haBlock;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(directory, "config.json"), JSON.stringify(old));
    assert.deepEqual((await ConfigStore.open(directory, {})).get().haBlock, DEFAULT_HA_BLOCK_CONFIG);
    await assert.rejects(store.save({ haBlock: { width: 2, unavailableDisplay: "na" } }), /three columns/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("geometry and placement save/discard atomically and newer edits survive acknowledgement", () => {
  const saved = structuredClone(DEFAULT_APP_CONFIG);
  saved.layout = [{ elementId: HA_BLOCK_ELEMENT_ID, startRow: 0, startColumn: 4, width: 3 }];
  const draft = updateHABlockDraft(saved, { ...active, width: 4, height: 2 });
  assert.deepEqual(draft.layout, [{ elementId: HA_BLOCK_ELEMENT_ID, startRow: 0, startColumn: 4, width: 4 }]);
  for (const section of ["layout", "haBlock"] as const) {
    assert.deepEqual(configPatchForSection(section, draft), { layout: draft.layout, haBlock: draft.haBlock });
    assert.equal(sectionIsDirty(section, draft, saved), true);
    assert.deepEqual(replaceSection(draft, saved, section), saved);
    const newer = updateHABlockDraft(draft, { ...draft.haBlock, height: 3 });
    const reconciled = reconcileSectionSave({ section, submittedDraft: draft, currentDraft: newer,
      acknowledgement: { config: draft, legacyEnvironmentVariables: [], hasSecrets: { token: false, localApiKey: false, haToken: false }, delivery: "unchanged" } });
    assert.equal(reconciled.newerEdits, true); assert.deepEqual(reconciled.draftConfig, newer);
  }
});
