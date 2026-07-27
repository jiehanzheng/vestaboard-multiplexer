import type { Priority, VestaboardMessage } from "../../orchestrator.js";
import { priorityValue } from "../../priority.js";
import { sanitizeDisplayText } from "./display/index.js";
import type { Logger, QuotaSnapshot, QuotaWindow } from "./types.js";

export const REFRESH_STATUS_MESSAGE_TTL_MS = 5 * 60_000;
export const TRANSIENT_STATUS_MESSAGE_TTL_MS = 1_000;

const STATUS_MESSAGE_PRIORITY = "high";
const STATUS_MESSAGE_PRIORITY_VALUE = priorityValue(STATUS_MESSAGE_PRIORITY);

interface QuotaCacheState {
  hasSnapshot: boolean;
  windowCount: number;
  updatedAt?: string;
}

interface StatusMessage {
  message: string;
  expiresAt: Date;
}

export class StatusMessageStack {
  private messages: StatusMessage[] = [];

  push(message: string, now: Date, ttlMs: number): void {
    this.prune(now);
    this.messages.push({ message, expiresAt: new Date(now.getTime() + ttlMs) });
  }

  pushLow(message: string, now: Date, ttlMs: number): void {
    this.prune(now);
    this.messages.unshift({ message, expiresAt: new Date(now.getTime() + ttlMs) });
  }

  top(now: Date): string | undefined {
    this.prune(now);
    return this.messages.at(-1)?.message;
  }

  private prune(now: Date): void {
    const nowMs = now.getTime();
    this.messages = this.messages.filter((message) => message.expiresAt.getTime() > nowMs);
  }
}

export class QuotaSnapshotCache {
  private cached: { snapshot: QuotaSnapshot; updatedAt: Date } | undefined;

  update(snapshot: QuotaSnapshot, now = new Date()): void {
    this.cached = {
      snapshot: cloneQuotaSnapshot(snapshot),
      updatedAt: new Date(now)
    };
  }

  snapshot(): QuotaSnapshot | undefined {
    return this.cached ? cloneQuotaSnapshot(this.cached.snapshot) : undefined;
  }

  state(): QuotaCacheState {
    return {
      hasSnapshot: this.cached !== undefined,
      windowCount: this.cached?.snapshot.windows.length ?? 0,
      updatedAt: this.cached?.updatedAt.toISOString()
    };
  }
}

export function errorStatus(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return summarizeBoardError(sanitizeDisplayText(detail));
}

export function autoStartErrorStatus(): string {
  return "AUTO PING FAIL";
}

export function logQuotaReadFailure(
  logger: Logger | undefined,
  error: unknown,
  errorPriority: Priority,
  message: VestaboardMessage,
  cacheState: QuotaCacheState
): void {
  logger?.warn("Codex quota read failed.", {
    reason: summarizeFailure(error),
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    fallbackPriority: String(errorPriority),
    cacheState,
    vestaboardPreview: messagePreview(message)
  });
}

export function logAutoStartFailure(logger: Logger | undefined, error: unknown): void {
  logger?.warn("Codex quota auto-start failed after quota read.", {
    reason: summarizeFailure(error),
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    boardStatus: autoStartErrorStatus()
  });
}

export function bumpStatusPriority(priority: Priority): Priority {
  return priorityValue(priority) >= STATUS_MESSAGE_PRIORITY_VALUE ? priority : STATUS_MESSAGE_PRIORITY;
}

function cloneQuotaSnapshot(snapshot: QuotaSnapshot): QuotaSnapshot {
  return {
    windows: snapshot.windows.map(cloneQuotaWindow)
  };
}

function cloneQuotaWindow(window: QuotaWindow): QuotaWindow {
  return {
    id: window.id,
    remainingRatio: window.remainingRatio,
    durationMins: window.durationMins,
    resetAt: window.resetAt ? new Date(window.resetAt) : undefined
  };
}

function summarizeBoardError(message: string): string {
  if (message.includes("TIMED OUT") || message.includes("TIMEOUT")) return "TIMEOUT";
  if (message.includes("INVALID JSON")) return "BAD JSON";
  if (message.includes("EXITED")) return "EXIT";
  if (message.includes("COULD NOT START")) return "START";
  if (message.includes("RATE LIMIT")) return "RATE LIMIT";
  if (message.includes("BUBBLEWRAP")) return "BWRAP";
  return "FETCH FAIL";
}

function messagePreview(message: VestaboardMessage): string {
  return message.text.replace(/\n/g, " | ");
}

function summarizeFailure(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.toUpperCase();
  if (normalized.includes("TIMED OUT") || normalized.includes("TIMEOUT")) return "timeout";
  if (normalized.includes("INVALID JSON")) return "invalid_json";
  if (normalized.includes("EXITED")) return "app_server_exited";
  if (normalized.includes("COULD NOT START")) return "app_server_start_failed";
  if (normalized.includes("RATE LIMIT")) return "rate_limit";
  if (normalized.includes("BUBBLEWRAP")) return "bubblewrap";
  return "unknown";
}
