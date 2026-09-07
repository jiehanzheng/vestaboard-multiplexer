import type { VestaboardMessage } from "./vestaboard.js";
import { isValidCharacterCode } from "./vestaboardCharacters.js";

/** Temporary stage-3 shape; the canonical config contract lands with stage 6. */
export interface LayoutEntry {
  elementId: string;
  startRow: number;
  startColumn?: number;
  width?: number;
}

/** A fixed-height contribution to a board layout. */
export interface Element {
  id: string;
  label: string;
  height: number;
  minWidth?: number;
  render(width: number): number[][];
}

/** The first row occupied by an element. Rows are zero based. */
export interface ComposeDimensions {
  width: number;
  height: number;
}

export interface ComposedElements extends VestaboardMessage {
  characters: number[][];
}

/**
 * Compose fixed-height elements into a board-sized character matrix.
 *
 * Layout validation happens before any output is returned so a bad layout
 * cannot silently produce a partially filled board.
 */
export function composeElements(
  elements: readonly Element[],
  layout: readonly LayoutEntry[],
  dimensions: ComposeDimensions
): ComposedElements {
  validateDimension(dimensions.width, "width");
  validateDimension(dimensions.height, "height");

  const elementsById = new Map<string, Element>();
  for (const element of elements) {
    if (!element || typeof element.id !== "string" || element.id.length === 0) {
      throw new Error("Every element must have a non-empty id.");
    }
    if (elementsById.has(element.id)) {
      throw new Error(`Duplicate element id '${element.id}'.`);
    }
    if (!Number.isInteger(element.height) || element.height <= 0) {
      throw new Error(`Element '${element.id}' must have a positive integer height.`);
    }
    if (element.minWidth !== undefined && (!Number.isInteger(element.minWidth) || element.minWidth <= 0)) {
      throw new Error(`Element '${element.id}' must have a positive integer minWidth.`);
    }
    if (typeof element.render !== "function") {
      throw new Error(`Element '${element.id}' must provide render(width).`);
    }
    elementsById.set(element.id, element);
  }

  const occupied = new Set<string>();
  const board = Array.from({ length: dimensions.height }, () => Array(dimensions.width).fill(0));
  for (const entry of layout) {
    const element = elementsById.get(entry.elementId);
    if (!element) {
      throw new Error(`Layout references unknown element '${entry.elementId}'.`);
    }
    if (!Number.isInteger(entry.startRow) || entry.startRow < 0) {
      throw new Error(`Layout start row for '${entry.elementId}' must be a non-negative integer.`);
    }
    const startColumn = entry.startColumn ?? 0;
    if (!Number.isInteger(startColumn) || startColumn < 0) {
      throw new Error(`Layout start column for '${entry.elementId}' must be a non-negative integer.`);
    }
    const width = entry.width ?? dimensions.width - startColumn;
    if (!Number.isInteger(width) || width <= 0) {
      throw new Error(`Layout width for '${entry.elementId}' must be a positive integer.`);
    }
    if (element.minWidth !== undefined && width < element.minWidth) {
      throw new Error(`Element '${entry.elementId}' requires at least ${element.minWidth} columns.`);
    }
    if (entry.startRow + element.height > dimensions.height) {
      throw new Error(`Element '${entry.elementId}' is out of bounds at row ${entry.startRow}.`);
    }
    if (startColumn + width > dimensions.width) {
      throw new Error(`Element '${entry.elementId}' is out of bounds at column ${startColumn}.`);
    }

    for (let row = entry.startRow; row < entry.startRow + element.height; row += 1) {
      for (let column = startColumn; column < startColumn + width; column += 1) {
        const cell = `${row}:${column}`;
        if (occupied.has(cell)) {
          throw new Error(`Element '${entry.elementId}' overlaps another element at row ${row}, column ${column}.`);
        }
        occupied.add(cell);
      }
    }

    const rendered = element.render(width);
    validateRenderedElement(element, rendered, width);
    for (const [rowOffset, row] of rendered.entries()) {
      board[entry.startRow + rowOffset]!.splice(startColumn, width, ...row);
    }
  }

  return {
    text: cellsToText(board),
    characters: board
  };
}

export function cellsToText(cells: readonly (readonly number[])[]): string {
  return cells.map((row) => row.map(characterForCode).join("")).join("\n");
}

function validateDimension(value: number | undefined, name: string): asserts value is number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Board ${name} must be a positive integer.`);
  }
}

function validateRenderedElement(element: Element, rendered: unknown, width: number): asserts rendered is number[][] {
  if (!Array.isArray(rendered) || rendered.length !== element.height) {
    throw new Error(`Element '${element.id}' must render exactly ${element.height} rows.`);
  }
  for (const row of rendered) {
    if (!Array.isArray(row) || row.length !== width) {
      throw new Error(`Element '${element.id}' must render exactly ${width} columns per row.`);
    }
    if (!row.every(isValidCharacterCode)) {
      throw new Error(`Element '${element.id}' rendered an invalid character code.`);
    }
  }
}

function characterForCode(code: number): string {
  if (code === 0) return " ";
  if (code >= 1 && code <= 26) return String.fromCharCode(64 + code);
  if (code >= 27 && code <= 36) return code === 36 ? "0" : String(code - 26);
  const punctuation: Record<number, string> = {
    37: "!", 38: "@", 39: "#", 40: "$", 41: "(", 42: ")", 44: "-",
    46: "+", 47: "&", 48: "=", 49: ";", 50: ":", 52: "'", 53: '"',
    54: "%", 55: ",", 56: ".", 59: "/", 60: "?", 62: "♥"
  };
  return punctuation[code] ?? " ";
}
