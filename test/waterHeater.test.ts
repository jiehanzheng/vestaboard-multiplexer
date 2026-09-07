import assert from "node:assert/strict";
import test from "node:test";

import { WaterHeater, createWaterHeaterIntegration, type WaterHeaterConfig } from "../src/plugins/waterHeater.js";
import type { HomeAssistantSnapshot } from "../src/homeAssistantService.js";
import type { HAEntity } from "../src/homeAssistant.js";
import { encode, BLUE } from "../src/vestaboardCharacters.js";

const baseConfig: WaterHeaterConfig = {
  remaining: { constant: 25 },
  capacity: { constant: 100 },
  temperature: { entityId: "sensor.tank" },
  target: { entityId: "sensor.target", attribute: "value" },
  emvPosition: null,
  unit: "F",
  baseline: 50,
  enabled: true
};

const entities: HAEntity[] = [
  { entity_id: "sensor.tank", state: "124.6", attributes: {}, last_updated: "2026-01-01T00:00:00Z" },
  { entity_id: "sensor.target", state: "unknown", attributes: { value: 135.2 }, last_updated: "2026-01-01T00:00:00Z" }
];

test("water owns HA source replacement and unsubscribes on stop", () => {
  let snapshot: HomeAssistantSnapshot = { source: "http://first", entities, connected: true };
  let listener: ((snapshot: HomeAssistantSnapshot) => void) | undefined;
  const source = { snapshot: () => snapshot, subscribe: (callback: typeof listener) => { listener = callback; return () => { listener = undefined; }; } };
  const water = createWaterHeaterIntegration(baseConfig, source, () => {});
  const initial = water.elements()[2]!.render(15);
  snapshot = { source: "http://first", entities: [], connected: false };
  listener?.(snapshot);
  assert.deepEqual(water.elements()[2]!.render(15), initial);
  snapshot = { source: "http://second", entities: [], connected: false };
  listener?.(snapshot);
  assert.notDeepEqual(water.elements()[2]!.render(15), initial);
  water.stop();
  assert.equal(listener, undefined);
});

test("renders width-aware remaining, temperature bar, and temperature text elements", () => {
  const heater = new WaterHeater(baseConfig);
  heater.update(baseConfig, entities);
  const elements = heater.elements();
  assert.deepEqual(elements.map(({ id }) => id), ["water.remaining", "water.temperature-bar", "water.temperature-text", "water.emv-position"]);
  assert.deepEqual(elements.map(({ minWidth }) => minWidth), [6, undefined, 8, 6]);
  for (const width of [15, 22]) {
    for (const element of elements) {
      assert.equal(element.render(width).length, 1);
      assert.equal(element.render(width)[0]?.length, width);
    }
  }
  assert.deepEqual(elements[2]?.render(15)[0]?.slice(0, 8), encode("125/135F"));
  assert.deepEqual(elements[3]?.render(6)[0]?.slice(0, 6), encode("MV N/A"));
  assert.equal(heater.status().error, undefined);
});

test("renders remaining as an HW bar with rounded gallons at both board widths", () => {
  const heater = new WaterHeater({ ...baseConfig, remaining: { constant: 25.6 } });
  heater.update({ ...baseConfig, remaining: { constant: 25.6 } }, entities);
  const remaining = heater.elements()[0]!;

  const note = remaining.render(15)[0]!;
  const flagship = remaining.render(22)[0]!;
  assert.equal(note.length, 15);
  assert.equal(flagship.length, 22);
  assert.deepEqual(note.slice(0, 2), [8, 23]);
  assert.deepEqual(note.slice(-3), [28, 32, 7]);
  assert.deepEqual(flagship.slice(-3), [28, 32, 7]);
  assert.equal(note.filter((cell) => cell === BLUE).length, 3);
  assert.equal(flagship.filter((cell) => cell === BLUE).length, 5);
});

test("bounds a large rounded gallons suffix while retaining a bar cell", () => {
  const config = { ...baseConfig, remaining: { constant: 123456789012 } };
  const heater = new WaterHeater(config);
  heater.update(config, entities);
  const row = heater.elements()[0]!.render(15)[0]!;
  assert.equal(row.length, 15);
  assert.deepEqual(row.slice(0, 2), [8, 23]);
  assert.equal(row.at(-1), 7);
  assert.equal(row[2], BLUE);
  assert.deepEqual(row.slice(-12), encode("99999999999G"));
  assert.equal(heater.elements()[0]!.render(4)[0]!.length, 4);
});

test("keeps the last valid reading through an unavailable entity and discards it when binding changes", () => {
  const heater = new WaterHeater(baseConfig);
  heater.update(baseConfig, entities);
  const unavailable = entities.map((entity) => entity.entity_id === "sensor.tank" ? { ...entity, state: "unavailable" } : entity);
  const status = heater.update(baseConfig, unavailable);
  assert.match(status.error ?? "", /temperature/i);
  assert.deepEqual(heater.elements()[2]!.render(15)[0]?.slice(0, 4), [27, 28, 31, 59]);

  const changed = { ...baseConfig, temperature: { entityId: "sensor.other" } };
  heater.update(changed, unavailable);
  assert.deepEqual(heater.elements()[2]!.render(15)[0]?.slice(0, 3), [14, 59, 1]);
});

test("renders EMV position from Home Assistant with explicit overflow", () => {
  const config = { ...baseConfig, emvPosition: { entityId: "sensor.emv" } };
  const heater = new WaterHeater(config);
  heater.update(config, [...entities, { entity_id: "sensor.emv", state: "1234.6", attributes: {}, last_updated: "2026-01-01T00:00:00Z" }]);
  const emv = heater.elements()[3]!;
  assert.deepEqual(emv.render(6)[0], encode("MV1235"));
  assert.deepEqual(emv.render(8)[0]?.slice(0, 6), encode("MV1235"));

  const large = { ...baseConfig, emvPosition: { constant: 123456 } };
  const largeHeater = new WaterHeater(large);
  largeHeater.update(large, []);
  assert.deepEqual(largeHeater.elements()[3]!.render(6)[0]?.slice(0, 6), encode("MV????"));
});

test("drafts retain last-good readings for unchanged bindings without changing live readings", () => {
  const heater = new WaterHeater(baseConfig);
  heater.update(baseConfig, entities);
  heater.update(baseConfig, []);
  const live = heater.elements()[2]!.render(15);
  assert.deepEqual(heater.previewElements({ ...baseConfig, baseline: 80 }, [])[2]!.render(15), live);
  const other = heater.previewElements({ ...baseConfig, temperature: { entityId: "sensor.other" } }, [])[2]!.render(15);
  assert.notDeepEqual(other, live);
  assert.deepEqual(heater.elements()[2]!.render(15), live);
});

test("reports invalid constants while leaving setup inputs optional", () => {
  const heater = new WaterHeater({ ...baseConfig, remaining: null, capacity: { constant: 0 } });
  const status = heater.update({ ...baseConfig, remaining: null, capacity: { constant: 0 } }, []);
  assert.match(status.error ?? "", /capacity.*positive/i);
  assert.deepEqual(heater.elements()[0]!.render(15)[0]?.slice(0, 3), [0, 0, 0]);
});

test("renders disabled water elements as blank rows", () => {
  const config = { ...baseConfig, enabled: false };
  const heater = new WaterHeater(config);
  heater.update(config, entities);
  for (const element of heater.elements()) {
    assert.ok(element.render(15)[0]?.every((cell) => cell === 0));
    assert.ok(element.render(22)[0]?.every((cell) => cell === 0));
  }
});

test("rejects malformed entity and numeric source definitions", () => {
  const heater = new WaterHeater({
    ...baseConfig,
    capacity: { entityId: "", attribute: " " },
    temperature: { constant: Number.NaN }
  });
  const status = heater.update({
    ...baseConfig,
    capacity: { entityId: "", attribute: " " },
    temperature: { constant: Number.NaN }
  }, []);
  assert.match(status.error ?? "", /capacity.*entity/i);
});
