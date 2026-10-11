import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHABlockIntegration, createHABlocksIntegration } from "../src/plugins/haBlock.js";
import { DEFAULT_HA_BLOCK_CONFIG, HABlockConfigSchema, HA_BLOCK_ELEMENT_ID, HABlocksSchema, legacyHABlock, type HABlockConfig } from "../src/plugins/haBlock/config.js";
import type { HomeAssistantSnapshot, HomeAssistantSnapshotListener } from "../src/homeAssistantService.js";
import { composeElements } from "../src/elements.js";
import { ConfigStore, DEFAULT_APP_CONFIG } from "../src/config.js";
import { addHABlockDraft, removeHABlockDraft, configPatchForSection, reconcileSectionSave, replaceSection, sectionIsDirty, updateHABlockDraft } from "../web/src/draftState.js";

const active: HABlockConfig = { ...DEFAULT_HA_BLOCK_CONFIG, enabled: true, entityId: "sensor.block" };
function fixture(config: HABlockConfig = active) {
  let time = 0;
  let snapshot: HomeAssistantSnapshot = { source: "http://ha.test", connected: true,
    entities: [{ entity_id: "sensor.block", state: "ready", attributes: { characters: [68, 10, 26] }, last_updated: "2000-01-01T00:00:00Z" }] };
  const listeners = new Set<HomeAssistantSnapshotListener>();
  let changes = 0;
  const plugin = createHABlockIntegration(config, { snapshot: () => snapshot, subscribe(_ids, callback) { listeners.add(callback); return () => { listeners.delete(callback); }; } }, () => { changes++; }, { info() {}, warn() {} }, () => new Date(time));
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
  assert.equal(f.changes(), 5);
  f.payload([69, 25, 13]);
  assert.equal(f.changes(), 5, "unchanged healthy payload does not emit another UI update");
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
    assert.deepEqual(store.get().haBlocks, []);
    await store.save({ haBlock: { width: 4, height: 2, unavailableDisplay: "blank" } });
    await store.save({ haBlock: { staleAfterMinutes: null } });
    assert.equal(store.get().haBlocks[0]!.width, 4); assert.equal(store.get().haBlocks[0]!.height, 2);
    assert.equal(store.get().haBlocks[0]!.unavailableDisplay, "blank");
    const old = JSON.parse(await readFile(join(directory, "config.json"), "utf8")); delete old.haBlocks;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(directory, "config.json"), JSON.stringify(old));
    assert.deepEqual((await ConfigStore.open(directory, {})).get().haBlocks, []);
    await assert.rejects(store.save({ haBlock: { width: 2, unavailableDisplay: "na" } }), /three columns/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("geometry and placement save/discard atomically and newer edits survive acknowledgement", () => {
  const saved = structuredClone(DEFAULT_APP_CONFIG);
  saved.layout = [{ elementId: HA_BLOCK_ELEMENT_ID, startRow: 0, startColumn: 4, width: 3 }];
  saved.haBlocks = [legacyHABlock(active)];
  const draft = updateHABlockDraft(saved, { ...saved.haBlocks[0]!, width: 4, height: 2 });
  assert.deepEqual(draft.layout, [{ elementId: HA_BLOCK_ELEMENT_ID, startRow: 0, startColumn: 4, width: 4 }]);
  for (const section of ["layout", "haBlock"] as const) {
    assert.deepEqual(configPatchForSection(section, draft), { layout: draft.layout, haBlocks: draft.haBlocks });
    assert.equal(sectionIsDirty(section, draft, saved), true);
    assert.deepEqual(replaceSection(draft, saved, section), saved);
    const newer = updateHABlockDraft(draft, { ...draft.haBlocks[0]!, height: 3 });
    const reconciled = reconcileSectionSave({ section, submittedDraft: draft, currentDraft: newer,
      acknowledgement: { config: draft, legacyEnvironmentVariables: [], hasSecrets: { token: false, localApiKey: false, haToken: false }, delivery: "unchanged" } });
    assert.equal(reconciled.newerEdits, true); assert.deepEqual(reconciled.draftConfig, newer);
  }
});

test("independent blocks share one subscription and isolate fallback, staleness, resizing, and removal", () => {
  let time = 0;
  let changes = 0;
  let snapshot: HomeAssistantSnapshot = { source: "http://ha.test", connected: true, entities: [
    { entity_id: "sensor.music", state: "ready", attributes: { characters: [68, 25, 13] } },
    { entity_id: "sensor.weather", state: "ready", attributes: { tiles: [1, 2, 3, 4] } }
  ] };
  const listeners = new Set<HomeAssistantSnapshotListener>();
  const music = { ...legacyHABlock(active), id: "music", name: "Music", entityId: "sensor.music", unavailableDisplay: "blank" as const, staleAfterMinutes: 1 };
  const weather = { ...legacyHABlock(active), id: "weather", name: "Weather", entityId: "sensor.weather", attribute: "tiles", width: 4, staleAfterMinutes: 2 };
  const plugin = createHABlocksIntegration([music, weather], {
    snapshot: () => snapshot, subscribe(_ids, callback) { listeners.add(callback); return () => { listeners.delete(callback); }; }
  }, () => { changes++; }, { info() {}, warn() {} }, () => new Date(time));
  const emit = () => { for (const listener of listeners) listener(snapshot); };
  assert.equal(listeners.size, 1);
  assert.deepEqual(plugin.elements().map((element) => element.id), ["ha-block.music", "ha-block.weather"]);
  assert.deepEqual(plugin.elements().map((element) => element.render(element.minWidth!)), [[[68, 25, 13]], [[1, 2, 3, 4]]]);
  snapshot = { ...snapshot, entities: [snapshot.entities[1]!] }; emit();
  assert.equal(changes, 1);
  assert.deepEqual(plugin.elements()[0]!.render(3), [[0, 0, 0]]);
  time = 60_000;
  assert.equal(plugin.status().music!.stale, true);
  assert.equal(plugin.status().weather!.stale, false);
  assert.equal(plugin.status().weather!.error, undefined);
  snapshot = { ...snapshot, entities: [] }; emit();
  assert.deepEqual(plugin.elements()[1]!.render(4), [[14, 59, 1, 0]]);
  assert.equal(plugin.status().weather!.unavailableSince, new Date(60_000).toISOString());
  time = 180_000;
  assert.equal(plugin.status().weather!.stale, true);
  snapshot = { ...snapshot, entities: [{ entity_id: "sensor.music", state: "ready", attributes: { characters: [69, 25, 13] } }] }; emit();
  assert.equal(plugin.status().music!.error, undefined);
  assert.equal(plugin.status().music!.unavailableSince, undefined);
  const draft = plugin.elements([{ ...music, width: 1, height: 3 }, weather]);
  assert.deepEqual(draft[0]!.render(1), [[69], [25], [13]]);
  assert.equal(plugin.elements()[0]!.height, 1);
  plugin.configure([{ ...music, name: "Radio" }]);
  assert.deepEqual(Object.keys(plugin.status()), ["music"]);
  assert.equal(plugin.elements()[0]!.label, "Radio");
  assert.equal(plugin.elements()[0]!.id, "ha-block.music");
  plugin.configure([]); assert.equal(plugin.enabled, false); assert.deepEqual(plugin.elements(), []);
  plugin.stop(); assert.equal(listeners.size, 0);
  assert.equal(HABlocksSchema.safeParse([music, { ...weather, id: "music" }]).success, false);
});

test("singleton saved configuration migrates without losing settings, placement, or delivery interval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ha-block-migration-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    const { haBlocks: _blocks, ...base } = structuredClone(DEFAULT_APP_CONFIG);
    const layout = [{ elementId: HA_BLOCK_ELEMENT_ID, startRow: 2, startColumn: 12, width: 3 }];
    const singleton = { ...active, unavailableDisplay: "blank" as const, staleAfterMinutes: null };
    await writeFile(join(directory, "config.json"), JSON.stringify({ version: 1, ...base, haBlock: singleton, layout, updateIntervalMinutes: 3 }));
    const store = await ConfigStore.open(directory, {});
    assert.equal(store.getPublic().error, undefined);
    assert.deepEqual(store.get().haBlocks, [legacyHABlock(singleton)]);
    assert.deepEqual(store.get().layout, layout);
    assert.equal(store.get().updateIntervalMinutes, 3);
    await store.save({ haBlocks: [...store.get().haBlocks, { ...legacyHABlock(active), id: "second", name: "Second", entityId: "sensor.second" }] });
    await store.save({ haBlock: { staleAfterMinutes: 5 } });
    assert.equal(store.get().haBlocks[0]!.staleAfterMinutes, 5);
    assert.equal(store.get().haBlocks[1]!.entityId, "sensor.second");
    const persisted = JSON.parse(await readFile(join(directory, "config.json"), "utf8"));
    assert.equal("haBlock" in persisted, false);
    assert.equal(persisted.haBlocks.length, 2);
    assert.deepEqual((await ConfigStore.open(directory, {})).get(), store.get());
    await assert.rejects(store.save({ haBlocks: [], haBlock: { enabled: false } }), /not both/);
    await assert.rejects(store.save({ haBlocks: [legacyHABlock(active), legacyHABlock(active)] }), /unique/);
    assert.equal(store.get().haBlocks.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("adding, resizing and removing an instance affects only that instance's placements and is reversible", () => {
  const base = structuredClone(DEFAULT_APP_CONFIG);
  let draft = addHABlockDraft(addHABlockDraft(base, "music"), "weather");
  assert.deepEqual(draft.haBlocks.map((block) => block.name), ["HA block 1", "HA block 2"]);
  draft.layout = [{ elementId: "ha-block.music", startRow: 0, width: 3 }, { elementId: "ha-block.weather", startRow: 1, width: 3 }, { elementId: "water.remaining", startRow: 2 }];
  const saved = structuredClone(draft);
  draft = updateHABlockDraft(draft, { ...draft.haBlocks[0]!, width: 4, name: "Music" });
  assert.equal(draft.layout![0]!.width, 4);
  assert.equal(draft.layout![1]!.width, 3);
  assert.equal(draft.haBlocks[1]!.name, "HA block 2");
  draft = removeHABlockDraft(draft, "music");
  assert.deepEqual(draft.haBlocks.map((block) => block.id), ["weather"]);
  assert.deepEqual(draft.layout, saved.layout!.slice(1));
  assert.deepEqual(replaceSection(draft, saved, "haBlock"), saved);
});
