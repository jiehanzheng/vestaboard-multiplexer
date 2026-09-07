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
  const occupied = new Map<string, string>();
  const dimensions = BOARD_DIMENSIONS[board];
  for (const entry of layout) {
    const element = elementById(elements, entry.elementId);
    if (!element) return `The selected element for layout item ${layout.indexOf(entry) + 1} is unavailable.`;
    const startColumn = layoutEntryStartColumn(entry);
    const width = layoutEntryWidth(entry, board);
    if (!Number.isInteger(entry.startRow) || entry.startRow < 0) return `${element.label} needs a valid start row.`;
    if (!Number.isInteger(startColumn) || startColumn < 0 || startColumn >= dimensions.columns) return `${element.label} needs a valid start character.`;
    if (!Number.isInteger(width) || width <= 0) return `${element.label} needs a positive width.`;
    const minWidth = element.minWidth ?? 1;
    if (width < minWidth) return `${element.label} needs at least ${minWidth} characters.`;
    if (entry.startRow + element.height > dimensions.rows) return `${element.label} extends past row ${dimensions.rows}.`;
    if (startColumn + width > dimensions.columns) return `${element.label} extends past character ${dimensions.columns}.`;
    for (let row = entry.startRow; row < entry.startRow + element.height; row += 1) {
      for (let column = startColumn; column < startColumn + width; column += 1) {
        const key = `${row}:${column}`;
        const previous = occupied.get(key);
        if (previous) return `${element.label} overlaps ${previous} at row ${row + 1}, character ${column + 1}.`;
        occupied.set(key, element.label);
      }
    }
  }
  return undefined;
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
