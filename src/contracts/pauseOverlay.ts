import { z } from "zod";
import { isValidCharacterCode, WHITE, type VestaboardBoardKind } from "../vestaboardCharacters.js";

export type PauseOverlayCell = number | null;
export type PauseOverlayCanvas = PauseOverlayCell[][];
export interface PauseOverlay {
  note: PauseOverlayCanvas;
  flagship: PauseOverlayCanvas;
}

export const PAUSE_OVERLAY_DIMENSIONS: Record<VestaboardBoardKind, { width: number; height: number }> = {
  note: { width: 15, height: 3 },
  flagship: { width: 22, height: 6 }
};

export const PauseOverlayCellSchema = z.union([z.null(), z.number().int().refine(isValidCharacterCode, "must be a valid Vestaboard character code")]);
export const PauseOverlayCanvasSchema = z.array(z.array(PauseOverlayCellSchema));
export const PauseOverlaySchema = z.object({ note: PauseOverlayCanvasSchema, flagship: PauseOverlayCanvasSchema }).strict().superRefine((overlay, context) => {
  for (const board of ["note", "flagship"] as const) {
    const dimensions = PAUSE_OVERLAY_DIMENSIONS[board];
    const canvas = overlay[board];
    if (canvas.length !== dimensions.height) context.addIssue({ code: z.ZodIssueCode.custom, path: [board], message: `${board} canvas must have ${dimensions.height} rows` });
    canvas.forEach((row, index) => {
      if (row.length !== dimensions.width) context.addIssue({ code: z.ZodIssueCode.custom, path: [board, index], message: `${board} row ${index + 1} must have ${dimensions.width} cells` });
    });
  }
});

/** Default bars are sparse so existing board content stays visible around the pause mark. */
export function defaultPauseOverlay(): PauseOverlay {
  return {
    note: pauseIcon(PAUSE_OVERLAY_DIMENSIONS.note, [5, 6, 8, 9], [0, 1, 2]),
    flagship: pauseIcon(PAUSE_OVERLAY_DIMENSIONS.flagship, [8, 9, 12, 13], [1, 2, 3, 4])
  };
}

function pauseIcon(dimensions: { width: number; height: number }, columns: readonly number[], rows: readonly number[]): PauseOverlayCell[][] {
  return Array.from({ length: dimensions.height }, (_, row) => Array.from({ length: dimensions.width }, (_, column) => rows.includes(row) && columns.includes(column) ? WHITE : null));
}
