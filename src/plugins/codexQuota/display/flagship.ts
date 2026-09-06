import type { VestaboardMessage } from "../../../vestaboard.js";
import type { ResetVisibility } from "../quotaWindowHistory.js";
import { hasQuotaWindowTiming, isLongQuotaWindow, quotaWindowLabel } from "../quotaWindow.js";
import type { QuotaSnapshot, QuotaWindow } from "../types.js";
import { barTextChar, quotaBar } from "./bars.js";
import {
  BLANK,
  encode,
  flagshipPercentLabel,
  hhmmWithColon,
  mmdd,
  sanitizeDisplayText,
  sanitizeRowText
} from "./shared.js";

const FLAGSHIP_COLUMNS = 22;
const FLAGSHIP_ROWS = 6;
const FLAGSHIP_BAR_WIDTH = 20;
const FLAGSHIP_USAGE_START = 6;
const FLAGSHIP_RESET_START = 11;
const FLAGSHIP_RESET_WIDTH = FLAGSHIP_COLUMNS - FLAGSHIP_RESET_START;
const FLAGSHIP_HEADER_RESET_START = FLAGSHIP_COLUMNS - "RESET".length;

export function formatFlagshipQuota(
  snapshot: QuotaSnapshot,
  {
    timeZone,
    now,
    statusMessage,
    staleWindowIds,
    showPacing,
    resetVisibility
  }: {
    timeZone?: string;
    now: Date;
    statusMessage?: string;
    staleWindowIds: string[];
    showPacing: boolean;
    resetVisibility: ResetVisibility;
  }
): VestaboardMessage {
  const windows = [0, 1].map((index) => flagshipWindow(snapshot.windows[index], index, {
    now,
    timeZone,
    stale: snapshot.windows[index] ? staleWindowIds.includes(snapshot.windows[index].id) : false,
    showPacing,
    showReset: snapshot.windows[index] ? resetVisibility[snapshot.windows[index].id] === true : false
  }));
  const rows = [
    flagshipHeaderRow(),
    windows[0].text,
    ` ${windows[0].barText} `,
    windows[1].text,
    ` ${windows[1].barText} `,
    padFlagshipRow(statusMessage ? sanitizeDisplayText(statusMessage) : "")
  ];

  return {
    text: rows.join("\n"),
    characters: [
      encodeFlagshipRow(rows[0]),
      encodeFlagshipRow(rows[1]),
      [BLANK, ...windows[0].barCharacters, BLANK],
      encodeFlagshipRow(rows[3]),
      [BLANK, ...windows[1].barCharacters, BLANK],
      encodeFlagshipRow(rows[5])
    ]
  };
}

export function formatFlagshipError(error: unknown, statusMessage?: string): VestaboardMessage {
  const detail = error instanceof Error ? error.message : String(error);
  return flagshipMessage([
    "CODEX QUOTA",
    "ERROR",
    statusMessage ?? sanitizeDisplayText(detail).slice(0, FLAGSHIP_COLUMNS),
    "",
    "",
    statusMessage === "AUTH EXPIRED" || statusMessage === "LOGIN NEEDED"
      ? "RUN CODEX LOGIN"
      : "CHECK API TOKEN"
  ]);
}

function flagshipHeaderRow(): string {
  return fixedFlagshipRow([
    { start: 0, text: "CODEX" },
    { start: FLAGSHIP_USAGE_START, text: "REMAINING" },
    { start: FLAGSHIP_HEADER_RESET_START, text: "RESET" }
  ]);
}

function flagshipQuotaTextRow(label: string, percent: string, reset: string): string {
  return fixedFlagshipRow([
    { start: 0, text: label },
    { start: FLAGSHIP_USAGE_START, text: percent },
    { start: FLAGSHIP_RESET_START, text: reset.padStart(FLAGSHIP_RESET_WIDTH, " ") }
  ]);
}

function fixedFlagshipRow(parts: Array<{ start: number; text: string }>): string {
  const row = Array(FLAGSHIP_COLUMNS).fill(" ");
  for (const part of parts) {
    const text = sanitizeRowText(part.text).slice(0, FLAGSHIP_COLUMNS - part.start);
    for (const [index, char] of [...text].entries()) {
      row[part.start + index] = char;
    }
  }

  return row.join("");
}

function flagshipWindow(
  window: QuotaWindow | undefined,
  index: number,
  options: {
    now: Date;
    timeZone?: string;
    stale: boolean;
    showPacing: boolean;
    showReset: boolean;
  }
): { text: string; barText: string; barCharacters: number[] } {
  if (!window) {
    return {
      text: " ".repeat(FLAGSHIP_COLUMNS),
      barText: " ".repeat(FLAGSHIP_BAR_WIDTH),
      barCharacters: Array(FLAGSHIP_BAR_WIDTH).fill(BLANK)
    };
  }

  const barCharacters = quotaBar(window, options.now, FLAGSHIP_BAR_WIDTH, options.stale, options.showPacing);
  return {
    text: flagshipQuotaTextRow(
      quotaWindowLabel(window, index),
      flagshipPercentLabel(window.remainingRatio),
      resetLabel(window, options.showReset, options.timeZone)
    ),
    barText: barCharacters.map(barTextChar).join(""),
    barCharacters
  };
}

function resetLabel(window: QuotaWindow, showReset: boolean, timeZone?: string): string {
  if (!showReset || !hasQuotaWindowTiming(window)) {
    return "";
  }

  return isLongQuotaWindow(window)
    ? `${mmdd(window.resetAt, timeZone)} ${hhmmWithColon(window.resetAt, timeZone)}`
    : hhmmWithColon(window.resetAt, timeZone);
}

function flagshipMessage(rows: string[]): VestaboardMessage {
  const paddedRows = rows.map(padFlagshipRow);
  while (paddedRows.length < FLAGSHIP_ROWS) {
    paddedRows.push(padFlagshipRow(""));
  }

  return {
    text: paddedRows.join("\n"),
    characters: paddedRows.map(encodeFlagshipRow)
  };
}

function encodeFlagshipRow(text: string): number[] {
  const row = encode(padFlagshipRow(text));
  if (row.length !== FLAGSHIP_COLUMNS) {
    throw new Error(`Vestaboard Flagship rows must be ${FLAGSHIP_COLUMNS} columns; got ${row.length}.`);
  }
  return row;
}

function padFlagshipRow(text: string): string {
  return sanitizeRowText(text).padEnd(FLAGSHIP_COLUMNS, " ").slice(0, FLAGSHIP_COLUMNS);
}
