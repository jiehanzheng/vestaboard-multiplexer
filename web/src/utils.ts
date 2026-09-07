import type { AppConfig } from "../../src/contracts/config.js";
import type { BoardKind } from "./types.js";
import { BOARD_DIMENSIONS } from "./layoutUtils.js";

export const EMPTY_MATRIX = (rows: number, columns: number): number[][] =>
  Array.from({ length: rows }, () => Array.from({ length: columns }, () => 0));

export function getBoardMatrix(characters: number[][] | undefined, board: BoardKind): number[][] {
  const dimensions = BOARD_DIMENSIONS[board];
  if (!characters || characters.length !== dimensions.rows || characters.some((row) => row.length !== dimensions.columns)) {
    return EMPTY_MATRIX(dimensions.rows, dimensions.columns);
  }
  return characters;
}

export function formatDate(value: number | string | undefined, empty = "No reading yet"): string {
  if (value === undefined || value === null || value === "") return empty;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return empty;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function relativeTime(value: number | string | undefined, empty = "No reading yet"): string {
  if (value === undefined || value === null || value === "") return empty;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return empty;
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

export function cloneConfig(config: AppConfig): AppConfig {
  return JSON.parse(JSON.stringify(config)) as AppConfig;
}

export function characterLabel(code: number): string {
  if (code === 0 || code === 70) return "";
  if (code >= 1 && code <= 26) return String.fromCharCode(64 + code);
  if (code >= 27 && code <= 36) return code === 36 ? "0" : String(code - 26);
  const punctuation: Record<number, string> = {
    37: "!", 38: "@", 39: "#", 40: "$", 41: "(", 42: ")", 44: "-",
    46: "+", 47: "&", 48: "=", 49: ";", 50: ":", 52: "'", 53: '"',
    54: "%", 55: ",", 56: ".", 59: "/", 60: "?", 62: "♥"
  };
  return punctuation[code] ?? "";
}

export function tileColor(code: number): string {
  if (code === 63) return "red";
  if (code === 64) return "orange";
  if (code === 65) return "yellow";
  if (code === 66) return "green";
  if (code === 67) return "blue";
  if (code === 68) return "violet";
  if (code === 69) return "white";
  return "black";
}
