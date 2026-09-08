import type { VestaboardMessage } from "./vestaboard.js";
import { cellsToText } from "./elements.js";
import { PAUSE_OVERLAY_DIMENSIONS, PauseOverlaySchema, type PauseOverlay } from "./contracts/pauseOverlay.js";
export { PAUSE_OVERLAY_DIMENSIONS, PauseOverlayCanvasSchema, PauseOverlayCellSchema, PauseOverlaySchema, defaultPauseOverlay } from "./contracts/pauseOverlay.js";
export type { PauseOverlay, PauseOverlayCanvas, PauseOverlayCell } from "./contracts/pauseOverlay.js";

/** Compose a saved overlay over the supplied board-sized frame. */
export function composePauseOverlay(message: VestaboardMessage, overlay: PauseOverlay, board: "note" | "flagship"): VestaboardMessage {
  const parsed = PauseOverlaySchema.parse(overlay);
  if (!message.characters) return structuredClone(message);
  const canvas = parsed[board];
  const dimensions = PAUSE_OVERLAY_DIMENSIONS[board];
  if (message.characters.length !== dimensions.height || message.characters.some((row) => row.length !== dimensions.width)) {
    throw new Error(`Pause overlay requires a ${dimensions.height} × ${dimensions.width} board frame.`);
  }
  const characters = message.characters.map((row, rowIndex) => row.map((cell, columnIndex) => canvas[rowIndex]![columnIndex] === null ? cell : canvas[rowIndex]![columnIndex]!));
  return { characters, text: cellsToText(characters, board) };
}
