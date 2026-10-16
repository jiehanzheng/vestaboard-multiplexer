import type { LayoutEntry } from "./config.js";

export const ELEMENT_STATES = ["active", "inactive", "unavailable"] as const;
export type ElementState = typeof ELEMENT_STATES[number];
export interface LayoutElement { id: string; label: string; height: number; minWidth?: number; state?: ElementState }
export interface LayoutDecision { index: number; elementId: string; state: ElementState; reason: "shown" | "inactive" | "suppressed"; blockedBy?: number }
interface Rectangle { row: number; column: number; width: number; height: number }
const intersects = (a: Rectangle, b: Rectangle) => a.row < b.row + b.height && b.row < a.row + a.height && a.column < b.column + b.width && b.column < a.column + a.width;

/** Validate dormant alternatives too: a source change must never turn a saved layout invalid. */
export function selectLayout(elements: readonly LayoutElement[], layout: readonly LayoutEntry[], dimensions: { width: number; height: number }): LayoutDecision[] {
  if (!Number.isInteger(dimensions.width) || dimensions.width <= 0 || !Number.isInteger(dimensions.height) || dimensions.height <= 0) throw new Error("Board dimensions must be positive integers.");
  const byId = new Map<string, LayoutElement>();
  for (const element of elements) {
    if (!element.id || byId.has(element.id)) throw new Error(`Duplicate or empty element id '${element.id}'.`);
    if (!Number.isInteger(element.height) || element.height <= 0) throw new Error(`Element '${element.id}' must have a positive integer height.`);
    if (element.minWidth !== undefined && (!Number.isInteger(element.minWidth) || element.minWidth <= 0)) throw new Error(`Element '${element.id}' must have a positive integer minWidth.`);
    if (element.state !== undefined && !ELEMENT_STATES.includes(element.state)) throw new Error(`Invalid state for '${element.id}'.`);
    byId.set(element.id, element);
  }
  const rectangles = layout.map((entry) => {
    const element = byId.get(entry.elementId);
    if (!element) throw new Error(`Layout references unknown element '${entry.elementId}'.`);
    if (!Number.isInteger(entry.startRow) || entry.startRow < 0) throw new Error(`Layout start row for '${entry.elementId}' must be a non-negative integer.`);
    const column = entry.startColumn ?? 0;
    if (!Number.isInteger(column) || column < 0) throw new Error(`Layout start column for '${entry.elementId}' must be a non-negative integer.`);
    const width = entry.width ?? dimensions.width - column;
    if (!Number.isInteger(width) || width <= 0) throw new Error(`Layout width for '${entry.elementId}' must be a positive integer.`);
    if (width < (element.minWidth ?? 1)) throw new Error(`Element '${entry.elementId}' requires at least ${element.minWidth ?? 1} columns.`);
    if (entry.startRow + element.height > dimensions.height) throw new Error(`Element '${entry.elementId}' is out of bounds at row ${entry.startRow}.`);
    if (column + width > dimensions.width) throw new Error(`Element '${entry.elementId}' is out of bounds at column ${column}.`);
    if (entry.priority !== undefined && !Number.isSafeInteger(entry.priority)) throw new Error("Priority must be a safe integer.");
    return { row: entry.startRow, column, width, height: element.height };
  });
  for (let right = 0; right < layout.length; right++) for (let left = 0; left < right; left++) {
    if (intersects(rectangles[left]!, rectangles[right]!) && (layout[left]!.priority === undefined || layout[right]!.priority === undefined)) {
      throw new Error(`Element '${layout[right]!.elementId}' overlaps another element at row ${Math.max(rectangles[left]!.row, rectangles[right]!.row)}, column ${Math.max(rectangles[left]!.column, rectangles[right]!.column)}. Enable priority on both placements to share space.`);
    }
  }
  const decisions: LayoutDecision[] = layout.map((entry, index) => ({ index, elementId: entry.elementId, state: byId.get(entry.elementId)!.state ?? "active", reason: "inactive" }));
  const selected: number[] = [];
  // Outage fallbacks must not hide healthy alternatives, but remain visible in otherwise unused space.
  const order = layout.map((_, index) => index).sort((a, b) =>
    Number(decisions[a]!.state === "unavailable") - Number(decisions[b]!.state === "unavailable") ||
    (layout[b]!.priority ?? 0) - (layout[a]!.priority ?? 0) || a - b);
  for (const index of order) {
    const decision = decisions[index]!;
    if (decision.state === "inactive") continue;
    const blocker = selected.find((other) => intersects(rectangles[index]!, rectangles[other]!));
    if (blocker === undefined) { decision.reason = "shown"; selected.push(index); }
    else { decision.reason = "suppressed"; decision.blockedBy = blocker; }
  }
  return decisions;
}
