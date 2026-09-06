import assert from "node:assert/strict";
import test from "node:test";

import { composeElements } from "../src/elements.js";
import {
  CODEX_STATUS_ID,
  CODEX_WINDOW_1_ID,
  CODEX_WINDOW_1_LARGE_ID,
  createCodexElements,
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

test("rejects unknown, overlapping, out-of-bounds, and malformed element layouts", () => {
  const element = { id: "one", label: "One", height: 1, render: (width: number) => [Array(width).fill(1)] };
  assert.throws(() => composeElements([element], [{ elementId: "missing", startRow: 0 }], { width: 2, height: 1 }), /unknown/);
  assert.throws(() => composeElements([element], [{ elementId: "one", startRow: 1.5 }], { width: 2, height: 2 }), /integer/);
  assert.throws(() => composeElements([element], [{ elementId: "one", startRow: 1 }, { elementId: "one", startRow: 1 }], { width: 2, height: 2 }), /overlaps|Duplicate/);
  assert.throws(() => composeElements([{ ...element, height: 2, render: (width: number) => [Array(width).fill(1), Array(width).fill(1)] }], [{ elementId: "one", startRow: 1 }], { width: 2, height: 2 }), /bounds/);
  assert.throws(() => composeElements([{ ...element, render: () => [[1]] }], [{ elementId: "one", startRow: 0 }], { width: 2, height: 1 }), /columns/);
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
  assert.equal(large.render(15).length, 2);
  assert.equal(large.render(22)[0]?.length, 22);
  assert.equal(status.render(15)[0]?.length, 15);
});
