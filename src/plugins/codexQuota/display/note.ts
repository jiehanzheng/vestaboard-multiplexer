import type { VestaboardMessage } from "../../../orchestrator.js";
import type { ResetVisibility } from "../quotaWindowHistory.js";
import { hasQuotaWindowTiming, isLongQuotaWindow, quotaWindowLabel } from "../quotaWindow.js";
import type { QuotaSnapshot, QuotaWindow } from "../types.js";
import { barTextChar, quotaBar } from "./bars.js";
import { encode, hhmm, mmdd, percentLabel, sanitizeDisplayText } from "./shared.js";

const BAR_WIDTH = 10;
const NOTE_COLUMNS = 15;

export function formatNoteQuota(
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
  const quotaRows = [0, 1].map((index) => noteQuotaLine(
    snapshot.windows[index],
    index,
    now,
    snapshot.windows[index] ? staleWindowIds.includes(snapshot.windows[index].id) : false,
    showPacing
  ));
  const footer = statusMessage
    ? statusLine(statusMessage)
    : resetLine(snapshot, resetVisibility, timeZone);

  return {
    text: [...quotaRows.map((row) => row.text), footer].join("\n"),
    characters: [...quotaRows.map((row) => row.characters), encodeNoteRow(footer)]
  };
}

export function formatNoteError(error: unknown, statusMessage?: string): VestaboardMessage {
  const detail = error instanceof Error ? error.message : String(error);
  const rows = ["CODEX QUOTA ERR", statusMessage ?? sanitizeDisplayText(detail).slice(0, NOTE_COLUMNS), ""];
  return {
    text: rows.join("\n"),
    characters: rows.map((row) => encodeNoteRow(row.padEnd(NOTE_COLUMNS, " ").slice(0, NOTE_COLUMNS)))
  };
}

function noteQuotaLine(
  window: QuotaWindow | undefined,
  index: number,
  now: Date,
  stale: boolean,
  showPacing: boolean
): { text: string; characters: number[] } {
  if (!window) {
    const text = " ".repeat(NOTE_COLUMNS);
    return { text, characters: encodeNoteRow(text) };
  }

  const label = quotaWindowLabel(window, index);
  const barCharacters = quotaBar(window, now, BAR_WIDTH, stale, showPacing);
  const percent = percentLabel(window.remainingRatio);

  return {
    text: `${label}${barCharacters.map(barTextChar).join("")}${percent}`,
    characters: [
      ...encode(label),
      ...barCharacters,
      ...encode(percent)
    ]
  };
}

function resetLine(snapshot: QuotaSnapshot, resetVisibility: ResetVisibility, timeZone?: string): string {
  const visible = snapshot.windows.filter((window) => (
    resetVisibility[window.id] === true
    && hasQuotaWindowTiming(window)
  ));

  if (visible.length === 0) {
    return " ".repeat(NOTE_COLUMNS);
  }

  if (visible.length === 1) {
    return padNoteRow(fullResetLabel(visible[0], timeZone));
  }

  const [first, second] = visible;
  const reset = isLongQuotaWindow(first) && isLongQuotaWindow(second)
    ? `${mmdd(first.resetAt!, timeZone)}♥${mmdd(second.resetAt!, timeZone)}`
    : `${fullResetLabel(first, timeZone)}♥${fullResetLabel(second, timeZone)}`;
  return padNoteRow(reset);
}

function fullResetLabel(window: QuotaWindow, timeZone?: string): string {
  if (!window.resetAt) {
    return "";
  }

  return isLongQuotaWindow(window)
    ? `${mmdd(window.resetAt, timeZone)}-${hhmm(window.resetAt, timeZone)}`
    : hhmm(window.resetAt, timeZone);
}

function statusLine(status: string): string {
  return padNoteRow(sanitizeDisplayText(status));
}

function padNoteRow(text: string): string {
  return text.padEnd(NOTE_COLUMNS, " ").slice(0, NOTE_COLUMNS);
}

function encodeNoteRow(text: string): number[] {
  const row = encode(text);
  if (row.length !== NOTE_COLUMNS) {
    throw new Error(`Vestaboard Note rows must be ${NOTE_COLUMNS} columns; got ${row.length}.`);
  }
  return row;
}
