import type { VestaboardMessage } from "../../../orchestrator.js";
import type { VestaboardBoard } from "../../../vestaboardTypes.js";
import { formatFlagshipError, formatFlagshipQuota } from "./flagship.js";
import { formatNoteError, formatNoteQuota } from "./note.js";
import { sanitizeDisplayText } from "./shared.js";
import type { ResetVisibility } from "../quotaWindowHistory.js";
import { hasQuotaWindowReset } from "../quotaWindow.js";
import type { QuotaSnapshot } from "../types.js";

export { sanitizeDisplayText };

export function formatQuota(
  snapshot: QuotaSnapshot,
  options: {
    timeZone?: string;
    now?: Date;
    statusMessage?: string;
    staleWindowIds?: string[];
    showPacing?: boolean;
    board?: VestaboardBoard;
    resetVisibility?: ResetVisibility;
  } = {}
): VestaboardMessage {
  const rendererOptions = {
    timeZone: options.timeZone,
    now: options.now ?? new Date(),
    statusMessage: options.statusMessage,
    staleWindowIds: options.staleWindowIds ?? [],
    showPacing: options.showPacing ?? true,
    resetVisibility: options.resetVisibility ?? defaultResetVisibility(snapshot)
  };

  return (options.board ?? "note") === "flagship"
    ? formatFlagshipQuota(snapshot, rendererOptions)
    : formatNoteQuota(snapshot, rendererOptions);
}

export function formatError(error: unknown, options: { board?: VestaboardBoard } = {}): VestaboardMessage {
  return options.board === "flagship"
    ? formatFlagshipError(error)
    : formatNoteError(error);
}

function defaultResetVisibility(snapshot: QuotaSnapshot): ResetVisibility {
  return Object.fromEntries(snapshot.windows.map((window) => [
    window.id,
    hasQuotaWindowReset(window) && window.remainingRatio < 1
  ]));
}
