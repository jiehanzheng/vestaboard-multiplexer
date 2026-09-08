import { useState, type ReactNode } from "react";
import { characterDisplay, characterOption, VESTABOARD_CHARACTER_CATALOG } from "../../src/vestaboardCharacters.js";
import { defaultPauseOverlay, type PauseOverlay, type PauseOverlayCanvas, type PauseOverlayCell } from "../../src/contracts/pauseOverlay.js";
import type { BoardMessage, BoardKind } from "./types";
import { characterLabel, getBoardMatrix } from "./utils";
import { BoardCell } from "./BoardCell";
import { BoardSurface } from "./BoardSurface";

export function PauseOverlayEditor({ board, value, background, onChange }: {
  board: BoardKind;
  value: PauseOverlay;
  background: BoardMessage | undefined;
  onChange: (value: PauseOverlay) => void;
}): ReactNode {
  const [selectedBrush, setSelectedBrush] = useState<PauseOverlayCell>(69);
  const canvas = value[board];
  const base = getBoardMatrix(background?.characters, board);
  const updateCanvas = (next: PauseOverlayCanvas): void => onChange({ ...value, [board]: next });
  const updateCell = (row: number, column: number): void => {
    updateCanvas(canvas.map((line, rowIndex) => line.map((cell, columnIndex) => rowIndex === row && columnIndex === column ? selectedBrush : cell)));
  };
  return (
    <section className="pause-overlay-editor" aria-labelledby="pause-overlay-heading">
      <div className="subheading-row">
        <div>
          <h3 id="pause-overlay-heading">Paused board drawing</h3>
          <p className="screen-footnote">Draw what appears over the last board frame while updates are paused. Checkerboard cells are transparent and show the board underneath.</p>
        </div>
        <span className="board-size">{board === "note" ? "Note · 3 × 15" : "Flagship · 6 × 22"}</span>
      </div>
      <div className="pause-overlay-tools">
        <label className="config-field" htmlFor="pause-overlay-brush"><span>Brush</span><select id="pause-overlay-brush" value={selectedBrush === null ? "transparent" : String(selectedBrush)} onChange={(event) => setSelectedBrush(event.target.value === "transparent" ? null : Number(event.target.value))}>
          <option value="transparent">Transparent eraser</option>
          {VESTABOARD_CHARACTER_CATALOG.map((option) => <option value={String(option.code)} key={option.code}>{option.code} · {option.name}{characterDisplay(option.code, board) ? ` · ${characterDisplay(option.code, board)}` : ""}</option>)}
        </select></label>
        <div className="pause-overlay-actions">
          <button className="button secondary" type="button" onClick={() => updateCanvas(canvas.map((line) => line.map(() => null)))}>Clear drawing</button>
          <button className="button secondary" type="button" onClick={() => updateCanvas(defaultPauseOverlay()[board])}>Reset to pause icon</button>
        </div>
      </div>
      <BoardSurface board={board} rows={canvas.map((line, row) => line.map((cell, column) => cell ?? base[row]?.[column] ?? 0))} className="pause-overlay-canvas" role="grid" ariaLabel={`${board === "note" ? "Note" : "Flagship"} pause drawing`} rowClassName="pause-overlay-row" renderRow={(shownRow, rowIndex) => shownRow.map((shownCode, column) => {
          const cell = canvas[rowIndex]?.[column] ?? null;
          const underlay = base[rowIndex]?.[column] ?? 0;
          const transparent = cell === null;
          return <BoardCell
            board={board}
            code={shownCode}
            as="button"
            className={`pause-overlay-cell${transparent ? " transparent" : ""}`}
            role="gridcell"
            ariaLabel={`Row ${rowIndex + 1}, character ${column + 1}: ${transparent ? `transparent over ${characterLabel(underlay, board) || "blank"}` : `${cell} ${characterOption(cell)?.name ?? "character"}`}`}
            onClick={() => updateCell(rowIndex, column)}
            key={`${rowIndex}-${column}`}
          >
            {transparent ? <span className="pause-overlay-transparent-mark" aria-hidden="true">·</span> : null}
          </BoardCell>;
        })} />
      <p className="inline-message info">Editing only changes this draft. Save the pause section to persist it; saved drawings use the normal delivery cadence when paused.</p>
    </section>
  );
}
