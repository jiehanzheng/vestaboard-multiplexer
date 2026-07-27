import { FIVE_HOUR_MINS, hasQuotaWindowReset, quotaWindowLabel, WEEK_MINS } from "./quotaWindow.js";
import type { QuotaSnapshot, QuotaWindow } from "./types.js";

export interface AutoStartQuotaConfig {
  fiveHour: boolean;
  weekly: boolean;
}

export interface AutoStartWindowCandidate {
  id: string;
  row: string;
  resetAtMs: number;
}

export type AutoStartPingPlan =
  | { type: "skip"; reason: "no-eligible-window" | "cooldown" }
  | { type: "ping"; trigger: "force"; windows: [] }
  | { type: "ping"; trigger: "unused-quota"; windows: AutoStartWindowCandidate[] };

export type ResetVisibility = Record<string, boolean>;

const AUTO_START_PING_COOLDOWN_MS = 30 * 60_000;

interface WindowHistoryEntry {
  lastSeenResetAtMs?: number;
  stableResetAtMs?: number;
  pingAttemptedResetAtMs?: number;
}

export class QuotaWindowHistory {
  private readonly windows = new Map<string, WindowHistoryEntry>();
  private lastPingAttemptAtMs: number | undefined;

  recordFreshSnapshot(snapshot: QuotaSnapshot): void {
    snapshot.windows.forEach((window) => this.recordFreshWindow(window, historyKey(snapshot, window)));
  }

  resetVisibilityFor(snapshot: QuotaSnapshot): ResetVisibility {
    return Object.fromEntries(snapshot.windows.map((window) => [
      window.id,
      this.shouldShowReset(window, historyKey(snapshot, window))
    ]));
  }

  planAutoStart(snapshot: QuotaSnapshot, config: AutoStartQuotaConfig, options: { force: boolean; now: Date }): AutoStartPingPlan {
    if (options.force) {
      return { type: "ping", trigger: "force", windows: [] };
    }

    if (this.isInCooldown(options.now)) {
      return { type: "skip", reason: "cooldown" };
    }

    const windows = this.autoStartCandidates(snapshot, config);
    return windows.length > 0
      ? { type: "ping", trigger: "unused-quota", windows }
      : { type: "skip", reason: "no-eligible-window" };
  }

  recordPingAttempt(plan: Extract<AutoStartPingPlan, { type: "ping" }>, now: Date): void {
    this.lastPingAttemptAtMs = now.getTime();
    if (plan.trigger === "force") {
      return;
    }

    for (const window of plan.windows) {
      this.historyEntry(window.id).pingAttemptedResetAtMs = window.resetAtMs;
    }
  }

  private recordFreshWindow(window: QuotaWindow, id: string): void {
    if (!hasQuotaWindowReset(window)) {
      return;
    }

    const entry = this.historyEntry(id);
    const resetAtMs = window.resetAt.getTime();
    entry.stableResetAtMs = entry.lastSeenResetAtMs === resetAtMs ? resetAtMs : undefined;
    entry.lastSeenResetAtMs = resetAtMs;
  }

  private shouldShowReset(window: QuotaWindow, id: string): boolean {
    if (!hasQuotaWindowReset(window)) {
      return false;
    }

    const resetAtMs = window.resetAt.getTime();
    return clamp(window.remainingRatio) < 1
      || this.historyEntry(id).stableResetAtMs === resetAtMs;
  }

  private isInCooldown(now: Date): boolean {
    return this.lastPingAttemptAtMs !== undefined
      && now.getTime() - this.lastPingAttemptAtMs < AUTO_START_PING_COOLDOWN_MS;
  }

  private autoStartCandidates(snapshot: QuotaSnapshot, config: AutoStartQuotaConfig): AutoStartWindowCandidate[] {
    return snapshot.windows.flatMap((window, index) => {
      const enabled = window.durationMins === FIVE_HOUR_MINS
        ? config.fiveHour
        : window.durationMins === WEEK_MINS && config.weekly;
      if (!enabled || !hasQuotaWindowReset(window) || clamp(window.remainingRatio) < 1) {
        return [];
      }

      const id = historyKey(snapshot, window);
      return this.historyEntry(id).pingAttemptedResetAtMs === window.resetAt.getTime()
        ? []
        : [{ id, row: quotaWindowLabel(window, index), resetAtMs: window.resetAt.getTime() }];
    });
  }

  private historyEntry(id: string): WindowHistoryEntry {
    const existing = this.windows.get(id);
    if (existing) {
      return existing;
    }

    const entry: WindowHistoryEntry = {};
    this.windows.set(id, entry);
    return entry;
  }
}

function historyKey(snapshot: QuotaSnapshot, window: QuotaWindow): string {
  // Codex may move a duration between primary and secondary, so slot identity is
  // only used when duration is unavailable or cannot distinguish simultaneous windows.
  if (window.durationMins === undefined || !Number.isFinite(window.durationMins) || window.durationMins <= 0) {
    return `slot:${window.id}`;
  }

  const durationKey = `duration:${window.durationMins}`;
  const sameDurationCount = snapshot.windows.filter((candidate) => candidate.durationMins === window.durationMins).length;
  return sameDurationCount > 1 ? `${durationKey}:slot:${window.id}` : durationKey;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
