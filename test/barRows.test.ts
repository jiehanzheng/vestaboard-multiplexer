import test from "node:test";
import assert from "node:assert/strict";
import { createBarRowsIntegration, BarRowConfigSchema, BarRowsSchema, barRowEntityIds, barRowGeometry } from "../src/plugins/barRows.js";
import type { HomeAssistantSnapshot, HomeAssistantSnapshotListener } from "../src/homeAssistantService.js";
import { DEFAULT_APP_CONFIG, validateConfig } from "../src/config.js";
import { ConfigPatchSchema } from "../src/contracts/config.js";
import { PreviewRequestSchema, PreviewResponseSchema } from "../src/contracts/api.js";
import { encode } from "../src/vestaboardCharacters.js";
const config = BarRowConfigSchema.parse({ id: "hot-water", name: "Hot water", enabled: true, source: { kind: "entity", entityId: "sensor.hot_water_display" } });
function fixture() {
  let time = 0;
  let snapshot: HomeAssistantSnapshot = { source: "ha", connected: true, entities: [] };
  const listeners = new Set<HomeAssistantSnapshotListener>();
  const plugin = createBarRowsIntegration([config], { snapshot: () => snapshot, subscribe(_ids, callback) { listeners.add(callback); return () => { listeners.delete(callback); }; } }, () => {}, () => new Date(time));
  function emit(patch: Partial<HomeAssistantSnapshot>) { snapshot = { ...snapshot, ...patch }; for (const listener of listeners) listener(snapshot); }
  function payload(current = 61.5, displayText = "3S", state = "ready", extra = {}) {
    emit({ entities: [{ entity_id: "sensor.hot_water_display", state, attributes: { display_name: "HW", current, max: 100, display_text: displayText, ...extra }, last_updated: "2000-01-01T00:00:00Z" }] });
  }
  return { plugin, emit, payload, time(value: number) { time = value; }, row(width = 15) { return plugin.elements()[0]!.render(width)[0]!; } };
}
test("fixed areas preserve ten-cell household bar and use ceiling fill at half boundaries", () => {
  const f = fixture();
  for (const [value, filled] of [[0, 0], [0.01, 1], [5, 1], [10, 1], [10.01, 2], [50, 5], [55, 6], [100, 10], [101, 10], [-1, 0]]) {
    f.payload(value!);
    assert.deepEqual(f.row(), [...encode("HW"), ...Array(filled).fill(67), ...Array(10 - filled!).fill(0), ...encode(" 3S")]);
  }
  f.payload(55, "S"); assert.deepEqual(f.row().slice(12), encode("  S"));
  assert.equal(f.row(22).filter((cell) => cell === 67).length, 10);
  assert.equal(f.row(8).length, 8); assert.deepEqual(barRowGeometry(config), { height: 1, minWidth: 6 });
});
test("all fields fail together immediately for invalid sources, overflow and unsupported text", () => {
  const f = fixture(); f.payload();
  for (const extra of [{ max: 0 }, { max: Infinity }, { current: null }, { display_name: "LONG" }, { display_text: "100S" }, { restored: true }]) {
    f.payload(50, "3S", "ready", extra);
    assert.deepEqual(f.row(), [...encode("N/A"), ...Array(12).fill(0)]);
    assert.equal(f.plugin.status()[config.id]!.state, "unavailable");
  }
  for (const state of ["unknown", "unavailable"]) { f.payload(50, "3S", state); assert.ok(f.plugin.status()[config.id]!.error); }
  f.payload(50, "3S", "other-healthy-state"); assert.equal(f.plugin.status()[config.id]!.state, "active");
  f.emit({ connected: false }); assert.deepEqual(f.row().slice(0, 3), encode("N/A"));
});
test("quiet sources do not age; failure age resets on recovery, rebinding and source replacement", () => {
  const f = fixture(); f.payload(); f.time(86400000); f.payload(); assert.equal(f.plugin.status()[config.id]!.stale, false);
  f.emit({ connected: false }); f.time(86400000 + 900000); assert.equal(f.plugin.status()[config.id]!.stale, true);
  f.emit({ source: "other" }); assert.equal(f.plugin.status()[config.id]!.stale, false);
  f.emit({ connected: true }); assert.equal(f.plugin.status()[config.id]!.unavailableSince, undefined);
});
test("per-field state/attribute bindings, constants and pure preview work without retained mixed values", () => {
  const f = fixture();
  const fields = BarRowConfigSchema.parse({ ...config, source: { kind: "fields", displayName: { kind: "constant", value: "HW" }, current: { kind: "entity", entityId: "sensor.gallons" }, max: { kind: "constant", value: 100 }, displayText: { kind: "entity", entityId: "sensor.text", attribute: "text" } } });
  const snapshot: HomeAssistantSnapshot = { source: "ha", connected: true, entities: [{ entity_id: "sensor.gallons", state: "50", attributes: {} }, { entity_id: "sensor.text", state: "ok", attributes: { text: "2S" } }] };
  const before = f.plugin.status();
  assert.deepEqual(f.plugin.elements([fields], snapshot)[0]!.render(15)[0], [...encode("HW"), ...Array(5).fill(67), ...Array(5).fill(0), ...encode(" 2S")]);
  assert.equal(f.plugin.previewStatus([fields], snapshot)[config.id]!.state, "active");
  assert.deepEqual(f.plugin.status(), before);
  assert.deepEqual(barRowEntityIds([fields]), ["sensor.gallons", "sensor.text"]);
  assert.equal(f.plugin.elements([fields], { ...snapshot, entities: snapshot.entities.slice(0, 1) })[0]!.state, "unavailable");
  const constants = BarRowConfigSchema.parse({ ...fields, source: { ...fields.source, current: { kind: "constant", value: 50 }, displayText: { kind: "constant", value: "2S" } } });
  assert.equal(f.plugin.elements([constants], { source: "", connected: false, entities: [] })[0]!.state, "active");
});
test("schema rejects duplicate identities, invalid geometry, types and fields", () => {
  assert.equal(BarRowsSchema.safeParse([config, config]).success, false);
  assert.equal(BarRowConfigSchema.safeParse({ ...config, labelWidth: 20, textWidth: 3 }).success, false);
  assert.equal(BarRowConfigSchema.safeParse({ ...config, source: { kind: "fields", displayName: { kind: "constant", value: 1 } } }).success, false);
});

test("disabled unbound defaults are valid and text uses shared display normalization", () => {
  assert.equal(BarRowConfigSchema.safeParse({ ...config, enabled: false, source: { kind: "entity", entityId: "" } }).success, true);
  assert.equal(BarRowConfigSchema.safeParse({ ...config, source: { kind: "entity", entityId: "" } }).success, false);
  const f = fixture(); f.payload(50, "és"); assert.deepEqual(f.row().slice(12), encode(" ES"));
  f.plugin.stop(); f.payload(10); assert.equal(f.plugin.status()[config.id]!.inputs.current.value, 50);
});

test("additive config and preview contracts preserve legacy defaults and stable placement identities", () => {
  const { barRows: _rows, ...legacy } = DEFAULT_APP_CONFIG;
  assert.deepEqual(validateConfig(legacy).barRows, []);
  const next = validateConfig({ ...legacy, barRows: [config], layout: [{ elementId: "bar-row.hot-water", startRow: 1, width: 15 }] });
  assert.deepEqual(next.haBlocks, DEFAULT_APP_CONFIG.haBlocks);
  assert.equal(ConfigPatchSchema.safeParse({ barRows: [] }).success, true);
  assert.equal(PreviewRequestSchema.safeParse({ layout: next.layout, barRows: [config] }).success, true);
  const f = fixture(); f.payload();
  assert.equal(PreviewResponseSchema.safeParse({ text: "", characters: [], barRows: f.plugin.previewStatus() }).success, true);
  f.plugin.configure([{ ...config, name: "Renamed" }]);
  assert.equal(f.plugin.elements()[0]!.id, "bar-row.hot-water");
  f.plugin.configure([]); assert.deepEqual(f.plugin.status(), {}); assert.deepEqual(f.plugin.elements(), []);
});

test("right-aligned suffix and left-aligned label keep fixed areas for empty and varying text", () => {
  const f = fixture();
  const expectedBar = [...Array(5).fill(67), ...Array(5).fill(0)];
  for (const [displayText, expected] of [["", "   "], ["S", "  S"], ["2S", " 2S"], ["12S", "12S"]]) {
    f.payload(50, displayText, "ready", { display_name: "H" });
    const row = f.row();
    assert.equal(row.length, 15);
    assert.deepEqual(row.slice(0, 2), encode("H "));
    assert.deepEqual(row.slice(2, 12), expectedBar);
    assert.deepEqual(row.slice(12), encode(expected!));
  }
  f.payload(50, "", "ready", { display_name: "" });
  assert.deepEqual(f.row().slice(0, 2), [0, 0]);
  assert.deepEqual(f.row().slice(2, 12), expectedBar);
});
