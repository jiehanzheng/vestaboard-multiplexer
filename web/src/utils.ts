import type { AppConfig, ConfigValue, LayoutEntry, BoardElement, BoardKind } from "./types";

export const BOARD_DIMENSIONS: Record<BoardKind, { rows: number; columns: number }> = {
  note: { rows: 3, columns: 15 },
  flagship: { rows: 6, columns: 22 }
};

export const EMPTY_MATRIX = (rows: number, columns: number): number[][] =>
  Array.from({ length: rows }, () => Array.from({ length: columns }, () => 0));

export function getBoardMatrix(characters: number[][] | undefined, board: BoardKind): number[][] {
  const dimensions = BOARD_DIMENSIONS[board];
  if (!characters || characters.length !== dimensions.rows || characters.some((row) => row.length !== dimensions.columns)) {
    return EMPTY_MATRIX(dimensions.rows, dimensions.columns);
  }
  return characters;
}

export function elementById(elements: BoardElement[], id: string): BoardElement | undefined {
  return elements.find((element) => element.id === id);
}

export function validateLayout(layout: LayoutEntry[], elements: BoardElement[], board: BoardKind): string | undefined {
  const occupied = new Map<number, string>();
  const maxRows = BOARD_DIMENSIONS[board].rows;
  for (const entry of layout) {
    const element = elementById(elements, entry.elementId);
    if (!element) return `The selected element for row ${layout.indexOf(entry) + 1} is unavailable.`;
    if (!Number.isInteger(entry.startRow) || entry.startRow < 0) {
      return `${element.label} needs a valid start row.`;
    }
    if (entry.startRow + element.height > maxRows) {
      return `${element.label} is ${entry.startRow + element.height - maxRows} row${entry.startRow + element.height - maxRows === 1 ? "" : "s"} too tall for this board.`;
    }
    for (let row = entry.startRow; row < entry.startRow + element.height; row += 1) {
      const previous = occupied.get(row);
      if (previous) return `${element.label} overlaps ${previous} on row ${row + 1}.`;
      occupied.set(row, element.label);
    }
  }
  return undefined;
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

function isObject(value: unknown): value is Record<string, ConfigValue | undefined> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getPath(config: AppConfig, paths: string[]): ConfigValue | undefined {
  for (const path of paths) {
    const value = path.split(".").reduce<ConfigValue | undefined>((current, key) => {
      return isObject(current) ? current[key] : undefined;
    }, config);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function hasPath(config: AppConfig, paths: string[]): string | undefined {
  return paths.find((path) => getPath(config, [path]) !== undefined);
}

export function setPath(config: AppConfig, path: string, value: ConfigValue): AppConfig {
  const parts = path.split(".");
  const next = cloneConfig(config);
  let cursor: Record<string, ConfigValue | undefined> = next;
  parts.forEach((part, index) => {
    if (index === parts.length - 1) {
      cursor[part] = value;
      return;
    }
    const existing = cursor[part];
    if (!isObject(existing)) cursor[part] = {};
    cursor = cursor[part] as Record<string, ConfigValue | undefined>;
  });
  return next;
}

export function setLayout(config: AppConfig, layout: LayoutEntry[]): AppConfig {
  const nestedPath = hasPath(config, ["elements_config.layout", "elementsConfig.layout"]);
  return setPath(config, nestedPath ?? "layout", layout);
}

export function getLayout(config: AppConfig): LayoutEntry[] | null | undefined {
  const value = getPath(config, ["elements_config.layout", "elementsConfig.layout", "layout"]);
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  return value.filter(isObject).flatMap((entry) => {
    const elementId = entry.elementId;
    const startRow = entry.startRow;
    return typeof elementId === "string" && typeof startRow === "number" ? [{ elementId, startRow }] : [];
  });
}

export function isLocked(locked: string[], paths: string[]): boolean {
  return paths.some((path) => locked.includes(path) || locked.some((entry) => entry.startsWith(`${path}.`)));
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
