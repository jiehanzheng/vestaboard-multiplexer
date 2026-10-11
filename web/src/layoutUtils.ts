import { selectLayout } from "../../src/contracts/layout.js";
import type { ElementsResponse } from "../../src/contracts/api.js";
import type { LayoutEntry } from "../../src/contracts/config.js";

export type BoardKind = "note" | "flagship";
export type BoardElement = ElementsResponse["elements"][number];

export const BOARD_DIMENSIONS: Record<BoardKind, { rows: number; columns: number }> = {
  note: { rows: 3, columns: 15 },
  flagship: { rows: 6, columns: 22 }
};

export function elementById(elements: readonly BoardElement[], id: string): BoardElement | undefined {
  return elements.find((element) => element.id === id);
}

export function layoutEntryStartColumn(entry: LayoutEntry): number {
  return entry.startColumn ?? 0;
}

export function layoutEntryWidth(entry: LayoutEntry, board: BoardKind): number {
  return entry.width ?? BOARD_DIMENSIONS[board].columns - layoutEntryStartColumn(entry);
}

export function layoutEntryKey(entry: LayoutEntry, board: BoardKind): string {
  return `${entry.elementId}:${entry.startRow}:${layoutEntryStartColumn(entry)}:${layoutEntryWidth(entry, board)}`;
}

export function validateLayout(layout: readonly LayoutEntry[], elements: readonly BoardElement[], board: BoardKind): string | undefined {
  const dimensions = BOARD_DIMENSIONS[board];
  try { selectLayout(elements, layout, { width: dimensions.columns, height: dimensions.rows }); return undefined; }
  catch (error) { return error instanceof Error ? error.message : "Invalid layout."; }
}

export function firstFreeRectangle(layout: readonly LayoutEntry[], elements: readonly BoardElement[], board: BoardKind, elementId: string): LayoutEntry | undefined {
  const element = elementById(elements, elementId);
  if (!element) return undefined;
  const dimensions = BOARD_DIMENSIONS[board];
  for (let row = 0; row <= dimensions.rows - element.height; row += 1) {
    for (let column = 0; column < dimensions.columns; column += 1) {
      const width = element.minWidth ?? dimensions.columns - column;
      if (width > dimensions.columns - column) continue;
      const candidate = { elementId, startRow: row, startColumn: column, width };
      if (!validateLayout([...layout, candidate], elements, board)) return candidate;
    }
  }
  return undefined;
}

export function sortLayoutIndexes(layout: readonly LayoutEntry[]): number[] {
  return layout.map((_, index) => index).sort((left, right) => layout[left].startRow - layout[right].startRow || layoutEntryStartColumn(layout[left]) - layoutEntryStartColumn(layout[right]) || left - right);
}

export function layoutRange(entry: LayoutEntry, element: BoardElement, board: BoardKind): string {
  const startColumn = layoutEntryStartColumn(entry);
  const width = layoutEntryWidth(entry, board);
  const endColumn = startColumn + width - 1;
  const rowText = `Row ${entry.startRow + 1}`;
  const rangeText = `characters ${startColumn + 1}–${endColumn + 1}`;
  const heightText = element.height > 1 ? ` · ${element.height} rows` : "";
  return `${rowText} · ${rangeText}${heightText}`;
}
