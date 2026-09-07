import assert from "node:assert/strict";
import test from "node:test";

import { WaterHeater, createWaterHeaterIntegration, waterElementIssue, type WaterHeaterConfig } from "../src/plugins/waterHeater.js";
import type { HomeAssistantSnapshot, HomeAssistantSnapshotListener } from "../src/homeAssistantService.js";
import type { HAEntity } from "../src/homeAssistant.js";
import { encode, BLUE } from "../src/vestaboardCharacters.js";

const baseConfig: WaterHeaterConfig = {
  remaining: { constant: 25 },
  capacity: { constant: 100 },
  temperature: { entityId: "sensor.tank" },
  target: { entityId: "sensor.target", attribute: "value" },
  emvPosition: null,
  heating: null,
  unit: "F",
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
  const initial = water.elements()[1]!.render(15);
  snapshot = { source: "http://first", entities: [], connected: false };
  listener?.(snapshot);
  assert.deepEqual(water.elements()[1]!.render(15), initial);
  snapshot = { source: "http://second", entities: [], connected: false };
  listener?.(snapshot);
  assert.notDeepEqual(water.elements()[1]!.render(15), initial);
  water.stop();
  assert.equal(listener, undefined);
});

test("water integration logs one diagnostic transition and one recovery", () => {
  let snapshot: HomeAssistantSnapshot = { source: "http://first", entities, connected: true };
  let listener: (() => void) | undefined;
  const warnings: string[] = [];
  const infos: string[] = [];
  const source = {
    snapshot: () => snapshot,
    subscribe: (callback: HomeAssistantSnapshotListener) => { listener = () => callback(snapshot); return () => { listener = undefined; }; }
  };
  const water = createWaterHeaterIntegration(baseConfig, source, () => {}, {
    warn: (message) => warnings.push(message),
    info: (message) => infos.push(message)
  });
  snapshot = { source: "http://first", entities: [], connected: false };
  listener?.();
  listener?.();
  snapshot = { source: "http://first", entities, connected: true };
  listener?.();
  assert.equal(warnings.length, 2);
  assert.equal(infos.length, 2);
  water.stop();
});

test("renders width-aware remaining and temperature text elements", () => {
  const heater = new WaterHeater(baseConfig);
  heater.update(baseConfig, entities);
  const elements = heater.elements();
  assert.deepEqual(elements.map(({ id }) => id), ["water.remaining", "water.temperature-text", "water.emv-position"]);
  assert.deepEqual(elements.map(({ minWidth }) => minWidth), [6, 8, 6]);
  for (const width of [15, 22]) {
    for (const element of elements) {
      assert.equal(element.render(width).length, 1);
      assert.equal(element.render(width)[0]?.length, width);
    }
  }
  assert.deepEqual(elements[1]?.render(15)[0]?.slice(0, 8), encode("125/135F"));
  assert.deepEqual(elements[2]?.render(6)[0]?.slice(0, 6), encode("MV N/A"));
  assert.equal(heater.status().error, undefined);
  assert.equal(heater.status().enabled, true);
  assert.deepEqual(heater.status().inputs.temperature, { configured: true, value: 124.6 });
  assert.deepEqual(heater.status().inputs.emvPosition, { configured: false });
});

test("uses the heart divider only for a recognized heating state", () => {
  const config = { ...baseConfig, heating: { entityId: "binary_sensor.heating" } };
  const entity = { entity_id: "binary_sensor.heating", state: "on", attributes: {}, last_updated: "2026-01-01T00:00:00Z" };
  const heater = new WaterHeater(config);
  heater.update(config, [...entities, entity]);
  assert.deepEqual(heater.elements()[1]!.render(15)[0]?.slice(0, 8), encode("125♥135F"));
  assert.equal(heater.status().inputs.heating?.value, true);

  heater.update(config, [...entities, { ...entity, state: "unknown" }]);
  assert.deepEqual(heater.elements()[1]!.render(15)[0]?.slice(0, 8), encode("125/135F"));
  assert.match(heater.status().inputs.heating?.error ?? "", /not on\/off/i);
  assert.equal(heater.status().inputs.heating?.retained, undefined);
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
  assert.equal(status.inputs.temperature.retained, true);
  assert.match(status.inputs.temperature.error ?? "", /sensor\.tank.*unavailable/i);
  assert.deepEqual(heater.elements()[1]!.render(15)[0]?.slice(0, 4), [27, 28, 31, 59]);

  const changed = { ...baseConfig, temperature: { entityId: "sensor.other" } };
  heater.update(changed, unavailable);
  assert.deepEqual(heater.elements()[1]!.render(15)[0]?.slice(0, 3), [14, 59, 1]);
});

test("diagnostics clear values after a binding change and isolate element dependencies", () => {
  const heater = new WaterHeater(baseConfig);
  heater.update(baseConfig, entities);
  const changed = { ...baseConfig, temperature: { entityId: "sensor.other" } };
  const status = heater.update(changed, entities);
  assert.equal(status.inputs.temperature.value, undefined);
  assert.equal(status.inputs.temperature.retained, undefined);
  assert.match(waterElementIssue("water.temperature-text", status) ?? "", /sensor\.other/);
  assert.equal(waterElementIssue("water.remaining", status), undefined);
  assert.equal(waterElementIssue("unknown", status), undefined);
  assert.equal(waterElementIssue("water.remaining", { ...status, enabled: false }), "Water heater is disabled.");
});

test("range diagnostics identify the invalid input", () => {
  const config = { ...baseConfig, remaining: { constant: -1 }, capacity: { constant: 0 } };
  const status = new WaterHeater(config).update(config, []);
  assert.match(status.inputs.remaining.error ?? "", /remaining.*non-negative/i);
  assert.match(status.inputs.capacity.error ?? "", /capacity.*positive/i);
});

test("renders EMV position from Home Assistant with explicit overflow", () => {
  const config = { ...baseConfig, emvPosition: { entityId: "sensor.emv" } };
  const heater = new WaterHeater(config);
  heater.update(config, [...entities, { entity_id: "sensor.emv", state: "1234.6", attributes: {}, last_updated: "2026-01-01T00:00:00Z" }]);
  const emv = heater.elements()[2]!;
  assert.deepEqual(emv.render(6)[0], encode("MV1235"));
  assert.deepEqual(emv.render(8)[0]?.slice(0, 6), encode("MV1235"));

  const large = { ...baseConfig, emvPosition: { constant: 123456 } };
  const largeHeater = new WaterHeater(large);
  largeHeater.update(large, []);
  assert.deepEqual(largeHeater.elements()[2]!.render(6)[0]?.slice(0, 6), encode("MV????"));
});

test("drafts retain last-good readings for unchanged bindings without changing live readings", () => {
  const heater = new WaterHeater(baseConfig);
  heater.update(baseConfig, entities);
  heater.update(baseConfig, []);
  const live = heater.elements()[1]!.render(15);
  assert.deepEqual(heater.previewElements(baseConfig, [])[1]!.render(15), live);
  const other = heater.previewElements({ ...baseConfig, temperature: { entityId: "sensor.other" } }, [])[1]!.render(15);
  assert.notDeepEqual(other, live);
  assert.deepEqual(heater.elements()[1]!.render(15), live);
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
