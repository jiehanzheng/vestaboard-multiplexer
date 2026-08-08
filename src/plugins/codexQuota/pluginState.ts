import type { Priority, VestaboardMessage } from "../../orchestrator.js";
import { priorityValue } from "../../priority.js";
import {
  classifyCodexFailure,
  codexAppServerErrorDetails,
  inspectCodexAuthStorage
} from "./failure.js";
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
  return classifyCodexFailure(error).boardStatus;
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
  const failure = classifyCodexFailure(error);
  const appServerError = codexAppServerErrorDetails(error);
  logger?.warn("Codex quota read failed.", {
    reason: failure.reason,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    ...(appServerError ? { appServerError } : {}),
    ...(failure.authenticationFailure ? {
      authStorage: inspectCodexAuthStorage(),
      recoveryCommand: "docker compose run --rm --build vestaboard-orchestrator codex login --device-auth"
    } : {}),
    fallbackPriority: String(errorPriority),
    cacheState,
    vestaboardPreview: messagePreview(message)
  });
}

export function logAutoStartFailure(logger: Logger | undefined, error: unknown): void {
  logger?.warn("Codex quota auto-start failed after quota read.", {
    reason: classifyCodexFailure(error).reason,
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

function messagePreview(message: VestaboardMessage): string {
  return message.text.replace(/\n/g, " | ");
}
