import assert from "node:assert/strict";
import test from "node:test";

import { cellsToText, composeElements } from "../src/elements.js";
import {
  CODEX_STATUS_ID,
  CODEX_WINDOW_1_ID,
  CODEX_WINDOW_1_LARGE_ID,
  CODEX_WINDOW_2_ID,
  CODEX_WINDOW_2_LARGE_ID,
  createCodexElements,
  defaultCodexLayout,
  type CodexQuotaDisplayState
} from "../src/plugins/codexQuota/elements.js";

test("composes fixed-height elements and maps character cells to text", () => {
  const elements = [
    { id: "top", label: "Top", height: 1, render: (width: number) => [Array(width).fill(1)] },
    { id: "bottom", label: "Bottom", height: 1, render: (width: number) => [Array(width).fill(2)] }
  ];

  const result = composeElements(elements, [
    { elementId: "top", startRow: 0 },
    { elementId: "bottom", startRow: 1 }
  ], { width: 3, height: 2 });

  assert.deepEqual(result.characters, [[1, 1, 1], [2, 2, 2]]);
  assert.equal(result.text, "AAA\nBBB");
});

test("maps code 62 according to the board when composing preview text", () => {
  assert.equal(cellsToText([[62]]), "♥");
  assert.equal(cellsToText([[62]], "note"), "♥");
  assert.equal(cellsToText([[62]], "flagship"), "°");
  const element = { id: "heart", label: "Heart", height: 1, render: (width: number) => [Array(width).fill(62)] };
  assert.equal(composeElements([element], [{ elementId: "heart", startRow: 0 }], { width: 22, height: 1 }, "flagship").text, "°".repeat(22));
});

test("rejects unknown, overlapping, out-of-bounds, and malformed element layouts", () => {
  const element = { id: "one", label: "One", height: 1, render: (width: number) => [Array(width).fill(1)] };
  assert.throws(() => composeElements([element], [{ elementId: "missing", startRow: 0 }], { width: 2, height: 1 }), /unknown/);
  assert.throws(() => composeElements([element], [{ elementId: "one", startRow: 1.5 }], { width: 2, height: 2 }), /integer/);
  assert.throws(() => composeElements([element], [{ elementId: "one", startRow: 1 }, { elementId: "one", startRow: 1 }], { width: 2, height: 2 }), /overlaps|Duplicate/);
  assert.throws(() => composeElements([{ ...element, height: 2, render: (width: number) => [Array(width).fill(1), Array(width).fill(1)] }], [{ elementId: "one", startRow: 1 }], { width: 2, height: 2 }), /bounds/);
  assert.throws(() => composeElements([{ ...element, render: () => [[1]] }], [{ elementId: "one", startRow: 0 }], { width: 2, height: 1 }), /columns/);
});

test("composes partial-width elements with rectangular occupancy", () => {
  const elements = [
    { id: "left", label: "Left", height: 2, minWidth: 2, render: (width: number) => [Array(width).fill(1), Array(width).fill(1)] },
    { id: "right", label: "Right", height: 2, render: (width: number) => [Array(width).fill(2), Array(width).fill(2)] }
  ];
  const result = composeElements(elements, [
    { elementId: "left", startRow: 0, startColumn: 1, width: 2 },
    { elementId: "right", startRow: 0, startColumn: 3, width: 1 }
  ], { width: 4, height: 2 });
  assert.deepEqual(result.characters, [[0, 1, 1, 2], [0, 1, 1, 2]]);
  assert.throws(() => composeElements(elements, [{ elementId: "left", startRow: 0, startColumn: 1, width: 1 }], { width: 4, height: 2 }), /at least 2/);
  assert.throws(() => composeElements(elements, [
    { elementId: "left", startRow: 0, startColumn: 1, width: 2 },
    { elementId: "right", startRow: 0, startColumn: 2, width: 2 }
  ], { width: 4, height: 2 }), /overlaps/);
});

test("Codex element IDs include compact and large window variants", () => {
  const state: CodexQuotaDisplayState = {
    staleWindowIds: [],
    resetVisibility: {},
    showPacing: false
  };
  const elements = createCodexElements(() => state);
  assert.deepEqual(elements.map(({ id }) => id).sort(), [
    "codex.header",
    "codex.reset-summary",
    "codex.status",
    "codex.window-1",
    "codex.window-1-large",
    "codex.window-2",
    "codex.window-2-large"
  ].sort());

  const compact = elements.find(({ id }) => id === CODEX_WINDOW_1_ID)!;
  const large = elements.find(({ id }) => id === CODEX_WINDOW_1_LARGE_ID)!;
  const status = elements.find(({ id }) => id === CODEX_STATUS_ID)!;
  assert.equal(compact.render(15).length, 1);
  assert.equal(compact.render(22)[0]?.length, 22);
  assert.equal(compact.minWidth, 6);
  assert.equal(compact.render(6)[0]?.length, 6);
  assert.equal(large.render(15).length, 2);
  assert.equal(large.render(22)[0]?.length, 22);
  assert.equal(large.minWidth, 6);
  assert.ok(large.render(6).every((row) => row.length === 6));
  assert.equal(status.render(15)[0]?.length, 15);
});

test("ranks Codex element windows by longest duration without mutating the snapshot", () => {
  const snapshot = {
    windows: [
      { id: "short", remainingRatio: 0.8, durationMins: 300 },
      { id: "long", remainingRatio: 0.6, durationMins: 10_080 }
    ]
  };
  const state: CodexQuotaDisplayState = {
    snapshot,
    staleWindowIds: [],
    resetVisibility: {},
    showPacing: false
  };
  const elements = createCodexElements(() => state);
  const longest = elements.find(({ id }) => id === CODEX_WINDOW_1_ID)!;
  const shorter = elements.find(({ id }) => id === CODEX_WINDOW_2_ID)!;
  assert.deepEqual(longest.render(15)[0]?.slice(0, 2), [23, 11]);
  assert.deepEqual(shorter.render(15)[0]?.slice(0, 2), [31, 8]);
  assert.deepEqual(snapshot.windows.map(({ id }) => id), ["short", "long"]);
  assert.deepEqual(defaultCodexLayout("note").map(({ elementId }) => elementId), [CODEX_WINDOW_1_ID, CODEX_WINDOW_2_ID, CODEX_STATUS_ID]);
  assert.deepEqual(defaultCodexLayout("flagship"), [
    "codex.header",
    CODEX_WINDOW_1_LARGE_ID,
    CODEX_WINDOW_2_LARGE_ID,
    CODEX_STATUS_ID
  ].map((elementId, index) => ({ elementId, startRow: [0, 1, 3, 5][index] })));
});

test("applies custom Codex labels to compact and large rows at both board widths", () => {
  const state: CodexQuotaDisplayState = {
    snapshot: { windows: [
      { id: "short", remainingRatio: 0.8, durationMins: 300 },
      { id: "long", remainingRatio: 0.6, durationMins: 10_080 }
    ] },
    staleWindowIds: [],
    resetVisibility: {},
    showPacing: false,
    windowLabels: ["X", "W2"]
  };
  const elements = createCodexElements(() => state);
  for (const id of [CODEX_WINDOW_1_ID, CODEX_WINDOW_2_ID, CODEX_WINDOW_1_LARGE_ID, CODEX_WINDOW_2_LARGE_ID]) {
    const element = elements.find((candidate) => candidate.id === id)!;
    assert.ok(element.render(15).every((row) => row.length === 15));
    assert.ok(element.render(22).every((row) => row.length === 22));
  }
  assert.deepEqual(elements.find(({ id }) => id === CODEX_WINDOW_1_ID)!.render(15)[0]?.slice(0, 1), [24]);
  assert.deepEqual(elements.find(({ id }) => id === CODEX_WINDOW_2_ID)!.render(22)[0]?.slice(0, 2), [23, 28]);
});

test("composes a weekly-only window into the first default slot on both boards", () => {
  const weeklyOnly: CodexQuotaDisplayState = {
    snapshot: { windows: [{ id: "weekly", remainingRatio: 0.6, durationMins: 10_080 }] },
    staleWindowIds: [],
    resetVisibility: {},
    showPacing: false
  };
  const elements = createCodexElements(() => weeklyOnly);
  const note = composeElements(elements, defaultCodexLayout("note"), { width: 15, height: 3 });
  const flagship = composeElements(elements, defaultCodexLayout("flagship"), { width: 22, height: 6 });

  assert.deepEqual(note.characters[0]?.slice(0, 2), [23, 11]);
  assert.ok(note.characters[1]?.every((cell) => cell === 0));
  assert.deepEqual(flagship.characters[1]?.slice(0, 2), [23, 11]);
  assert.ok(flagship.characters[3]?.every((cell) => cell === 0));

  const explicitState: CodexQuotaDisplayState = {
    ...weeklyOnly,
    snapshot: { windows: [
      { id: "short", remainingRatio: 0.8, durationMins: 300 },
      { id: "weekly", remainingRatio: 0.6, durationMins: 10_080 }
    ] }
  };
  const explicitElements = createCodexElements(() => explicitState);
  const saved = composeElements(explicitElements, [
    { elementId: CODEX_WINDOW_2_ID, startRow: 0 },
    { elementId: CODEX_WINDOW_1_ID, startRow: 1 },
    { elementId: CODEX_STATUS_ID, startRow: 2 }
  ], { width: 15, height: 3 });
  assert.deepEqual(saved.characters[0]?.slice(0, 2), [31, 8]);
  assert.deepEqual(saved.characters[1]?.slice(0, 2), [23, 11]);
});
