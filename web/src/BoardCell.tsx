import type { ReactNode } from "react";
import { characterLabel, tileColor } from "./utils";
import type { BoardKind } from "./types";
import heartAsset from "./assets/heart.png";

interface BoardCellProps {
  board: BoardKind;
  code: number;
  as?: "span" | "button";
  className?: string;
  ariaHidden?: boolean;
  ariaLabel?: string;
  role?: string;
  onClick?: () => void;
  children?: ReactNode;
}

/** Shared board tile keeps official character rendering and tile sizing in one path. */
export function BoardCell({ board, code, as = "span", className, ariaHidden, ariaLabel, role, onClick, children }: BoardCellProps): ReactNode {
  const label = characterLabel(code, board);
  const classes = ["board-cell", tileColor(code), label ? "has-glyph" : "", className ?? ""].filter(Boolean).join(" ");
  const glyph = code === 62 && board === "note"
    ? <img className="heart-glyph" src={heartAsset} alt="" />
    : label;
  const content = <>{glyph}{children}</>;

  if (as === "button") {
    return <button className={classes} type="button" role={role} aria-label={ariaLabel} aria-hidden={ariaHidden} onClick={onClick}>{content}</button>;
  }
  return <span className={classes} role={role} aria-label={ariaLabel} aria-hidden={ariaHidden}>{content}</span>;
}
