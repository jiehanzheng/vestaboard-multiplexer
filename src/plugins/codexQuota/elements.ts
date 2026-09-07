import type { Element, LayoutEntry } from "../../elements.js";
import { formatQuota } from "./display/index.js";
import { quotaBar } from "./display/bars.js";
import { BLANK, encode, percentLabel } from "./display/shared.js";
import { quotaWindowLabel } from "./quotaWindow.js";
import type { CodexQuotaDisplayState } from "./plugin.js";

export type { CodexQuotaDisplayState } from "./plugin.js";

export const CODEX_HEADER_ID = "codex.header";
export const CODEX_RESET_SUMMARY_ID = "codex.reset-summary";
export const CODEX_STATUS_ID = "codex.status";
export const CODEX_WINDOW_1_ID = "codex.window-1";
export const CODEX_WINDOW_2_ID = "codex.window-2";
export const CODEX_WINDOW_1_LARGE_ID = "codex.window-1-large";
export const CODEX_WINDOW_2_LARGE_ID = "codex.window-2-large";

export function createCodexElements(
  getDisplayState: () => CodexQuotaDisplayState,
  now: () => Date = () => new Date()
): Element[] {
  return [
    {
      id: CODEX_HEADER_ID,
      label: "Codex header",
      height: 1,
      render: (width) => [fitRow(headerRow(), width)]
    },
    {
      id: CODEX_RESET_SUMMARY_ID,
      label: "Codex reset summary",
      height: 1,
      render: (width) => [fitRow(noteMessage(getDisplayState(), now).characters?.[2] ?? [], width)]
    },
    {
      id: CODEX_STATUS_ID,
      label: "Codex status",
      height: 1,
      render: (width) => [fitRow(statusMessage(getDisplayState(), width, now), width)]
    },
    createCompactWindow(CODEX_WINDOW_1_ID, 0, getDisplayState, now),
    createCompactWindow(CODEX_WINDOW_2_ID, 1, getDisplayState, now),
    createLargeWindow(CODEX_WINDOW_1_LARGE_ID, 0, getDisplayState, now),
    createLargeWindow(CODEX_WINDOW_2_LARGE_ID, 1, getDisplayState, now)
  ];
}

export function defaultCodexLayout(board: "note" | "flagship"): LayoutEntry[] {
  return board === "note"
      ? [
        { elementId: CODEX_WINDOW_1_ID, startRow: 0 },
        { elementId: CODEX_WINDOW_2_ID, startRow: 1 },
        { elementId: CODEX_STATUS_ID, startRow: 2 }
      ]
    : [
        { elementId: CODEX_HEADER_ID, startRow: 0 },
        { elementId: CODEX_WINDOW_1_LARGE_ID, startRow: 1 },
        { elementId: CODEX_WINDOW_2_LARGE_ID, startRow: 3 },
        { elementId: CODEX_STATUS_ID, startRow: 5 }
      ];
}

function createCompactWindow(id: string, index: number, getDisplayState: () => CodexQuotaDisplayState, now: () => Date): Element {
  return {
      id,
      label: `Codex window ${index + 1}`,
      height: 1,
      minWidth: 6,
      render: (width) => {
        const state = getDisplayState();
        return [compactWindowRow(state, index, width, now)];
      }
  };
}

function createLargeWindow(id: string, index: number, getDisplayState: () => CodexQuotaDisplayState, now: () => Date): Element {
  return {
    id,
    label: `Codex large window ${index + 1}`,
    height: 2,
    minWidth: 6,
      render: (width) => {
        const state = getDisplayState();
        if (width >= 22) {
        const message = formatForWindow(state, index, width, now);
        return [
          fitRow(message?.characters?.[1] ?? [], width),
          fitRow(message?.characters?.[2] ?? [], width)
        ];
      }

      return largeCompactRows(state, index, width, now);
    }
  };
}

function compactWindowRow(state: CodexQuotaDisplayState, index: number, width: number, now: () => Date): number[] {
  const window = rankedWindows(state.snapshot)[index];
  if (!window) return blankRow(width);
  const label = state.windowLabels?.[index] ?? quotaWindowLabel(window, index);
  const percent = percentLabel(window.remainingRatio);
  const barWidth = width - [...label].length - [...percent].length;
  const bar = quotaBar(
    window,
    now(),
    barWidth,
    state.staleWindowIds.includes(window.id),
    state.showPacing
  );
  return [
    ...encode(label),
    ...bar,
    ...encode(percent)
  ];
}

function largeCompactRows(state: CodexQuotaDisplayState, index: number, width: number, now: () => Date): number[][] {
  const window = rankedWindows(state.snapshot)[index];
  if (!window) return [blankRow(width), blankRow(width)];
  const label = state.windowLabels?.[index] ?? quotaWindowLabel(window, index);
  const percent = percentLabel(window.remainingRatio);
  const firstRow = [
    ...encode(label),
    ...Array(width - [...label].length - [...percent].length).fill(BLANK),
    ...encode(percent)
  ];
  const bar = quotaBar(
    window,
    now(),
    width - 2,
    state.staleWindowIds.includes(window.id),
    state.showPacing
  );
  return [firstRow, [BLANK, ...bar, BLANK]];
}

function formatForWidth(state: CodexQuotaDisplayState, width: number, now: () => Date = () => new Date()) {
  const board = width >= 22 ? "flagship" : "note";
  return formatQuota(state.snapshot ?? { windows: [] }, {
    board,
    timeZone: state.timeZone,
    now: now(),
    statusMessage: state.statusMessage,
    staleWindowIds: state.staleWindowIds,
    showPacing: state.showPacing,
    resetVisibility: state.resetVisibility,
    windowLabels: state.windowLabels
  });
}

function formatForWindow(state: CodexQuotaDisplayState, index: number, width: number, now: () => Date) {
  const window = rankedWindows(state.snapshot)[index];
  return window
    ? formatQuota({ windows: [window] }, {
        board: width >= 22 ? "flagship" : "note",
        timeZone: state.timeZone,
        now: now(),
        statusMessage: state.statusMessage,
        staleWindowIds: state.staleWindowIds,
        showPacing: state.showPacing,
        resetVisibility: state.resetVisibility,
        windowLabels: [state.windowLabels?.[index]]
      })
    : undefined;
}

function rankedWindows(snapshot: CodexQuotaDisplayState["snapshot"]): NonNullable<CodexQuotaDisplayState["snapshot"]>["windows"] {
  return [...(snapshot?.windows ?? [])]
    .map((window, index) => ({ window, index }))
    .sort((left, right) => {
      const leftKnown = knownDuration(left.window.durationMins);
      const rightKnown = knownDuration(right.window.durationMins);
      if (leftKnown === undefined && rightKnown === undefined) return left.index - right.index;
      if (leftKnown === undefined) return 1;
      if (rightKnown === undefined) return -1;
      return rightKnown - leftKnown || left.index - right.index;
    })
    .map(({ window }) => window);
}

function knownDuration(durationMins: number | undefined): number | undefined {
  return durationMins !== undefined && Number.isFinite(durationMins) && durationMins > 0
    ? durationMins
    : undefined;
}

function noteMessage(state: CodexQuotaDisplayState, now: () => Date = () => new Date()) {
  return formatQuota(state.snapshot ?? { windows: [] }, {
    board: "note",
    timeZone: state.timeZone,
    now: now(),
    statusMessage: state.statusMessage,
    staleWindowIds: state.staleWindowIds,
    showPacing: state.showPacing,
    resetVisibility: state.resetVisibility,
    windowLabels: state.windowLabels
  });
}

function statusMessage(state: CodexQuotaDisplayState, width: number, now: () => Date): number[] {
  if (width >= 22) {
    return formatForWidth(state, width, now).characters?.[5] ?? blankRow(width);
  }

  return noteMessage(state, now).characters?.[2] ?? blankRow(width);
}

function headerRow(): number[] {
  return formatQuota({ windows: [] }, { board: "flagship" }).characters?.[0] ?? [];
}

function fitRow(row: readonly number[], width: number): number[] {
  return [...row.slice(0, width), ...Array(Math.max(0, width - row.length)).fill(0)];
}

function blankRow(width: number): number[] {
  return Array(width).fill(0);
}
