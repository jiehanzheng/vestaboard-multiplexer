import test from "node:test";
import assert from "node:assert/strict";
import { composeElements, type Element } from "../src/elements.js";
import { selectLayout } from "../src/contracts/layout.js";
import { createHABlocksIntegration } from "../src/plugins/haBlock.js";
import { DEFAULT_HA_BLOCK_CONFIG } from "../src/plugins/haBlock/config.js";
import { encode, encodeDisplayText } from "../src/vestaboardCharacters.js";
import type { HomeAssistantSnapshot } from "../src/homeAssistantService.js";
import { validateLayout } from "../web/src/layoutUtils.js";

const element = (id: string, code: number, state: Element["state"] = "active"): Element => ({ id, label: id, height: 1, minWidth: 1, state, render: (width) => [Array(width).fill(code)] });
const dimensions = { width: 15, height: 3 };

test("exclusive layouts still reject overlap, and every alternative opts in", () => {
  const elements = [element("water", 1), element("music", 2)];
  const layout = [{ elementId: "water", startRow: 2, width: 8 }, { elementId: "music", startRow: 2, width: 15, priority: 100 }];
  assert.throws(() => composeElements(elements, layout, dimensions), /Enable priority on both/);
  layout[0]!.priority = 0;
  assert.deepEqual(composeElements(elements, layout, dimensions).characters[2], Array(15).fill(2));
  assert.equal(validateLayout(layout, elements.map((value) => ({ ...value, preview: [] })), "note"), undefined);
});

test("priority owns whole rectangles, zero cells are opaque, and ties use saved order", () => {
  const elements = [element("water", 1), element("music", 0)];
  const layout = [{ elementId: "water", startRow: 2, width: 8, priority: 0 }, { elementId: "music", startRow: 2, width: 15, priority: 100 }];
  assert.deepEqual(composeElements(elements, layout, dimensions).characters[2], Array(15).fill(0));
  layout[1]!.priority = 0;
  assert.equal(selectLayout(elements, layout, dimensions)[1]!.blockedBy, 0);
  assert.equal(selectLayout(elements, [...layout].reverse(), dimensions)[1]!.blockedBy, 0);
  assert.deepEqual(composeElements(elements, layout, dimensions).characters[2], [...Array(8).fill(1), ...Array(7).fill(0)]);
});

test("suppressed alternatives reserve no cells, while inactive geometry is still validated", () => {
  const elements = [element("a", 1), element("b", 2), element("c", 3)];
  const layout = [
    { elementId: "a", startRow: 0, startColumn: 0, width: 3, priority: 3 },
    { elementId: "b", startRow: 0, startColumn: 2, width: 4, priority: 2 },
    { elementId: "c", startRow: 0, startColumn: 5, width: 3, priority: 1 }
  ];
  assert.deepEqual(selectLayout(elements, layout, dimensions).map((d) => d.reason), ["shown", "suppressed", "shown"]);
  elements[0]!.state = "inactive";
  assert.deepEqual(selectLayout(elements, layout, dimensions).map((d) => d.reason), ["inactive", "shown", "suppressed"]);
  assert.throws(() => composeElements(elements, [{ ...layout[0]!, startRow: 3 }], dimensions), /out of bounds/);
});

test("display text normalizes supported glyphs without weakening native code validation", () => {
  assert.deepEqual(encodeDisplayText('  Beyoncé — “1989” 🎵  song  '), encode('BEYONCE - "1989" SONG'));
  assert.deepEqual(encodeDisplayText("🎵"), []);
});

test("HA activity distinguishes inactive from unavailable; text can bind an independent source", () => {
  let snapshot: HomeAssistantSnapshot = { source: "ha", connected: true, entities: [] };
  const block = { ...DEFAULT_HA_BLOCK_CONFIG, id: "music", name: "Music", enabled: true, entityId: "sensor.music",
    width: 15, unavailableDisplay: "blank" as const, activityAttribute: "active", textAttribute: "media_title", textEntityId: "media_player.music" };
  let callback: (snapshot: HomeAssistantSnapshot) => void = () => {};
  let ids: readonly string[] = [];
  const plugin = createHABlocksIntegration([block], { snapshot: () => snapshot,
    subscribe(next, listener) { ids = next; callback = listener; return () => {}; } }, () => {}, { info() {}, warn() {} });
  const emit = (active: unknown, title: unknown, characters: unknown = [10, 26, 68]) => {
    snapshot = { ...snapshot, entities: [
      { entity_id: "sensor.music", state: "ready", attributes: { active, characters } },
      { entity_id: "media_player.music", state: "paused", attributes: { media_title: title } }
    ] }; callback(snapshot);
  };
  try {
    assert.deepEqual(ids, ["sensor.music", "media_player.music"]);
    emit(true, "Beyoncé — Very Long Song");
    assert.deepEqual(plugin.elements()[0]!.render(15)[0], [10, 26, 68, ...encode("BEYONCE - VE")]);
    assert.equal(plugin.status().music!.textTruncated, true);
    emit(true, "1989", [10, 26, 69]);
    assert.deepEqual(plugin.elements()[0]!.render(15)[0]!.slice(0, 7), [10, 26, 69, ...encode("1989")]);
    emit(false, 1989, []);
    assert.equal(plugin.elements()[0]!.state, "inactive", "inactive source does not require renderable content");
    assert.equal(plugin.status().music!.error, undefined);
    emit("false", "Title"); assert.equal(plugin.elements()[0]!.state, "unavailable");
    emit(true, 1989); assert.match(plugin.status().music!.error!, /string/);
    emit(true, "Title", Array(16).fill(1)); assert.match(plugin.status().music!.error!, /capacity/);
    emit(true, ""); assert.equal(plugin.elements()[0]!.state, "active");
    const water = element("water", 1);
    const layout = [{ elementId: "water", startRow: 2, width: 8, priority: 0 }, { elementId: "ha-block.music", startRow: 2, width: 15, priority: 100 }];
    emit(false, "Title"); assert.equal(composeElements([water, ...plugin.elements()], layout, dimensions).characters[2]![0], 1);
    snapshot = { ...snapshot, connected: false }; callback(snapshot);
    assert.equal(plugin.elements()[0]!.state, "unavailable");
    assert.deepEqual(composeElements([water, ...plugin.elements()], layout, dimensions).characters[2], Array(15).fill(0), "fallback reserves the high-priority rectangle");
    plugin.configure([{ ...block, textEntityId: "media_player.other" }]);
    assert.deepEqual(ids, ["sensor.music", "media_player.other"]);
  } finally { plugin.stop(); }
});

test("priority and HA bindings discard atomically without losing unrelated settings", async () => {
  const { DEFAULT_APP_CONFIG } = await import("../src/config.js");
  const { updateHABlockDraft, replaceSection, configPatchForSection } = await import("../web/src/draftState.js");
  const block = { ...DEFAULT_HA_BLOCK_CONFIG, id: "music", name: "Music", entityId: "sensor.music", enabled: true };
  const saved = { ...structuredClone(DEFAULT_APP_CONFIG), updateIntervalMinutes: 3, haBlocks: [block],
    layout: [{ elementId: "ha-block.music", startRow: 2, startColumn: 12, width: 3 }] };
  const resized = updateHABlockDraft(saved, { ...block, width: 15, activityAttribute: "active", textAttribute: "media_title", textEntityId: "media_player.music" });
  const draft = { ...resized, layout: [{ ...resized.layout![0]!, startColumn: 0, priority: 100 },
    { elementId: "water.temperature-text", startRow: 2, width: 8, priority: 0 }] };
  assert.deepEqual(configPatchForSection("layout", draft), { haBlocks: draft.haBlocks, layout: draft.layout });
  const restored = replaceSection(draft, saved, "layout");
  assert.deepEqual(restored.haBlocks, saved.haBlocks); assert.deepEqual(restored.layout, saved.layout);
  assert.equal(restored.updateIntervalMinutes, 3);
});
