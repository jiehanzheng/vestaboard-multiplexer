import assert from "node:assert/strict";
import test from "node:test";
import type { LayoutEntry } from "../src/contracts/config.js";
import type { BoardElement } from "../web/src/layoutUtils.js";
import { firstFreeRectangle, layoutEntryWidth, sortLayoutIndexes, validateLayout } from "../web/src/layoutUtils.js";

const elements = [
  { id: "compact", label: "Compact", height: 1, minWidth: 2, preview: [[1, 2, 3, 4]] },
  { id: "tall", label: "Tall", height: 2, preview: [[1], [2]] }
] as BoardElement[];

test("layout validation supports legacy full rows and adjacent rectangles", () => {
  const legacy: LayoutEntry = { elementId: "compact", startRow: 0 };
  assert.equal(layoutEntryWidth(legacy, "note"), 15);
  assert.equal(validateLayout([
    { elementId: "compact", startRow: 0, startColumn: 0, width: 5 },
    { elementId: "compact", startRow: 0, startColumn: 5, width: 5 }
  ], elements, "note"), undefined);
  assert.match(validateLayout([
    { elementId: "compact", startRow: 0, startColumn: 0, width: 5 },
    { elementId: "compact", startRow: 0, startColumn: 4, width: 5 }
  ], elements, "note") ?? "", /overlaps/);
});

test("layout validation reports minimum width and first placement uses it", () => {
  assert.match(validateLayout([{ elementId: "compact", startRow: 0, startColumn: 0, width: 1 }], elements, "note") ?? "", /at least 2/);
  assert.deepEqual(firstFreeRectangle([], elements, "note", "compact"), { elementId: "compact", startRow: 0, startColumn: 0, width: 2 });
  assert.deepEqual(sortLayoutIndexes([
    { elementId: "tall", startRow: 1, startColumn: 0, width: 3 },
    { elementId: "compact", startRow: 0, startColumn: 8, width: 2 },
    { elementId: "compact", startRow: 0, startColumn: 2, width: 2 }
  ]), [2, 1, 0]);
});
