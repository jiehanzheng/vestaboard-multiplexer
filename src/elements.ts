import { selectLayout, type ElementState, type LayoutDecision } from "./contracts/layout.js";
import type { VestaboardMessage } from "./vestaboard.js";
import type { LayoutEntry } from "./contracts/config.js";
export type { LayoutEntry } from "./contracts/config.js";
import { characterDisplay, isValidCharacterCode, type VestaboardBoardKind } from "./vestaboardCharacters.js";

/** A fixed-height contribution to a board layout. */
export interface Element {
  id: string;
  label: string;
  height: number;
  minWidth?: number;
  state?: ElementState;
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
  dimensions: ComposeDimensions,
  boardKind: VestaboardBoardKind = dimensions.width === 22 ? "flagship" : "note",
  onSelection?: (decisions: LayoutDecision[]) => void
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

  const decisions = selectLayout(elements, layout, dimensions);
  onSelection?.(decisions);
  const board = Array.from({ length: dimensions.height }, () => Array(dimensions.width).fill(0));
  for (const decision of decisions) {
    if (decision.reason !== "shown") continue;
    const entry = layout[decision.index]!;
    const element = elementsById.get(entry.elementId)!;
    const startColumn = entry.startColumn ?? 0;
    const width = entry.width ?? dimensions.width - startColumn;
    const rendered = element.render(width);
    validateRenderedElement(element, rendered, width);
    for (const [rowOffset, row] of rendered.entries()) {
      board[entry.startRow + rowOffset]!.splice(startColumn, width, ...row);
    }
  }

  return {
    text: cellsToText(board, boardKind),
    characters: board
  };
}

export function cellsToText(cells: readonly (readonly number[])[], board: VestaboardBoardKind = "note"): string {
  return cells.map((row) => row.map((code) => characterForCode(code, board)).join("")).join("\n");
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

function characterForCode(code: number, board: VestaboardBoardKind): string {
  return characterDisplay(code, board) || " ";
}
