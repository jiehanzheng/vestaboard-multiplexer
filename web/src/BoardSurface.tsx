import type { CSSProperties, ReactNode } from "react";
import { BOARD_DIMENSIONS } from "./layoutUtils";
import type { BoardKind } from "./types";

interface BoardSurfaceProps {
  board: BoardKind;
  rows: readonly (readonly number[])[];
  columns?: number;
  className?: string;
  rowClassName?: string;
  rowLabel?: (rowIndex: number) => string;
  role?: string;
  ariaLabel?: string;
  renderRow: (row: readonly number[], rowIndex: number) => ReactNode;
}

/** Shared board geometry lets each surface supply its own interaction content. */
export function BoardSurface({ board, rows, columns = BOARD_DIMENSIONS[board].columns, className, rowClassName, rowLabel, role, ariaLabel, renderRow }: BoardSurfaceProps): ReactNode {
  return <div className={`board-surface${className ? ` ${className}` : ""}`} role={role} aria-label={ariaLabel} style={{ "--board-columns": columns } as CSSProperties}>
    {rows.map((row, rowIndex) => <div className={`board-row${rowClassName ? ` ${rowClassName}` : ""}`} key={`board-row-${rowIndex}`} role={role === "grid" ? "row" : undefined} aria-label={rowLabel?.(rowIndex)}>{renderRow(row, rowIndex)}</div>)}
  </div>;
}
