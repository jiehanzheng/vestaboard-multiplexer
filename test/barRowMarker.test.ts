import test from "node:test";
import assert from "node:assert/strict";
import { BarRowConfigSchema, barRowEntityIds, createBarRowsIntegration } from "../src/plugins/barRows.js";
import type { HomeAssistantSnapshot, HomeAssistantSnapshotListener } from "../src/homeAssistantService.js";
import { encode } from "../src/vestaboardCharacters.js";

const row = BarRowConfigSchema.parse({ id: "level", name: "Level", enabled: true,
  source: { kind: "entity", entityId: "sensor.level", attributes: { marker: "bar_marker" } } });
function fixture() {
  let time = 0;
  let snapshot: HomeAssistantSnapshot = { source: "ha", connected: true, entities: [] };
  const listeners = new Set<HomeAssistantSnapshotListener>();
  const plugin = createBarRowsIntegration([row], {
    snapshot: () => snapshot,
    subscribe(_ids, listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }
  }, () => {}, () => new Date(time));
  return { plugin, time(value: number) { time = value; },
    payload(marker: unknown, current = 50) {
      snapshot = { ...snapshot, entities: [{ entity_id: "sensor.level", state: "ready",
        attributes: { display_name: "LV", current, max: 100, display_text: "OK", bar_marker: marker } }] };
      for (const listener of listeners) listener(snapshot);
    },
    render(width = 15) { return plugin.elements()[0]!.render(width)[0]!; }
  };
}

test("HA marker arrays render exact codes after ceiling fill and replace trailing cells near the end", () => {
  const f = fixture();
  for (const [current, start] of [[-1, 0], [0, 0], [0.1, 1], [50, 5], [85, 8], [100, 8], [120, 8]]) {
    f.payload([62, 66], current!);
    const fill = Math.ceil(Math.max(0, Math.min(1, current! / 100)) * 10);
    const bar = [...Array(fill).fill(67), ...Array(10 - fill).fill(0)];
    bar.splice(start!, 2, 62, 66);
    assert.deepEqual(f.render(), [...encode("LV"), ...bar, ...encode(" OK")]);
  }
  f.payload([0, 1, 70]);
  assert.deepEqual(f.render().slice(7, 10), [0, 1, 70], "blank, letter and color codes pass through unchanged");
  f.plugin.stop();
});

test("empty arrays hide the marker; unmapped legacy rows ignore HA marker attributes", () => {
  const f = fixture(); f.payload([]);
  const ordinary = [...encode("LV"), ...Array(5).fill(67), ...Array(5).fill(0), ...encode(" OK")];
  assert.deepEqual(f.render(), ordinary);
  f.plugin.configure([BarRowConfigSchema.parse({ ...row, source: { kind: "entity", entityId: "sensor.level" } })]);
  f.payload("ignored");
  assert.deepEqual(f.render(), ordinary);
  assert.equal(f.plugin.status().level!.inputs.marker, undefined);
  f.plugin.stop();
});

test("missing, non-array and invalid codes use the normal failure/staleness path without coercion", () => {
  const f = fixture();
  for (const invalid of [undefined, null, true, "[62]", "♥", ["62"], [true], [62.1], [-1], [43], [71], [[62]]]) {
    f.payload(invalid);
    assert.deepEqual(f.render(), [...encode("N/A"), ...Array(12).fill(0)]);
    assert.match(f.plugin.status().level!.inputs.marker!.error!, /array of supported integer character codes/);
    assert.equal(f.plugin.status().level!.state, "unavailable");
  }
  f.time(900000); assert.equal(f.plugin.status().level!.stale, true);
  f.payload([]); assert.equal(f.plugin.status().level!.stale, false);
  assert.equal(f.plugin.status().level!.unavailableSince, undefined);
  f.plugin.stop();
});

test("marker overflow uses placement fallback without truncating or changing wider renders", () => {
  const f = fixture(); f.payload([62, 66]);
  assert.deepEqual(f.render(6), [...encode("N/A"), 0, 0, 0]);
  assert.deepEqual(f.render(7), [...encode("LV"), 62, 66, ...encode(" OK")]);
  assert.equal(f.render(15)[7], 62);
  f.plugin.configure([{ ...row, unavailableDisplay: "blank" }]);
  assert.deepEqual(f.render(6), Array(6).fill(0));
  f.plugin.stop();
});

test("individual marker attribute bindings subscribe and preview without mutating live state", () => {
  const f = fixture(); f.payload([]);
  const draft = BarRowConfigSchema.parse({ ...row, source: { kind: "fields",
    displayName: { kind: "constant", value: "LV" }, current: { kind: "constant", value: 50 },
    max: { kind: "constant", value: 100 }, displayText: { kind: "constant", value: "OK" },
    marker: { kind: "entity", entityId: "sensor.marker", attribute: "codes" } } });
  const snapshot: HomeAssistantSnapshot = { source: "ha", connected: true, entities: [
    { entity_id: "sensor.marker", state: "ready", attributes: { codes: [62] } }
  ] };
  assert.deepEqual(barRowEntityIds([draft]), ["sensor.marker"]);
  const before = f.plugin.status();
  for (let repeat = 0; repeat < 2; repeat++) {
    assert.equal(f.plugin.elements([draft], snapshot)[0]!.render(15)[0]![7], 62);
    assert.deepEqual(f.plugin.previewStatus([draft], snapshot).level!.inputs.marker!.value, [62]);
  }
  assert.deepEqual(f.plugin.status(), before);
  f.plugin.configure([draft]);
  assert.equal(f.plugin.elements([draft], { ...snapshot, connected: false })[0]!.state, "unavailable");
  f.plugin.stop();
});
