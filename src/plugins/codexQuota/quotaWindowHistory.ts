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
  resetObservationCounts: Map<number, number>;
  pingAttemptedResetAtMs: Set<number>;
}

export class QuotaWindowHistory {
  private readonly windows = new Map<string, WindowHistoryEntry>();
  private lastPingAttemptAtMs: number | undefined;

  recordFreshSnapshot(snapshot: QuotaSnapshot): void {
    const resetsByWindow = new Map<string, Set<number>>();
    for (const window of snapshot.windows) {
      if (!hasQuotaWindowReset(window)) {
        continue;
      }

      const id = historyIdentity(window);
      const resets = resetsByWindow.get(id) ?? new Set<number>();
      resets.add(window.resetAt.getTime());
      resetsByWindow.set(id, resets);
    }

    for (const [id, resets] of resetsByWindow) {
      const entry = this.historyEntry(id);
      entry.resetObservationCounts = new Map([...resets].map((resetAtMs) => [
        resetAtMs,
        Math.min(2, (entry.resetObservationCounts.get(resetAtMs) ?? 0) + 1)
      ]));
    }
  }

  resetVisibilityFor(snapshot: QuotaSnapshot): ResetVisibility {
    return Object.fromEntries(snapshot.windows.map((window) => [
      window.id,
      this.shouldShowReset(window, historyIdentity(window))
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
      this.historyEntry(window.id).pingAttemptedResetAtMs.add(window.resetAtMs);
    }
  }

  private shouldShowReset(window: QuotaWindow, id: string): boolean {
    if (!hasQuotaWindowReset(window)) {
      return false;
    }

    const resetAtMs = window.resetAt.getTime();
    return clamp(window.remainingRatio) < 1
      || (this.historyEntry(id).resetObservationCounts.get(resetAtMs) ?? 0) >= 2;
  }

  private isInCooldown(now: Date): boolean {
    return this.lastPingAttemptAtMs !== undefined
      && now.getTime() - this.lastPingAttemptAtMs < AUTO_START_PING_COOLDOWN_MS;
  }

  private autoStartCandidates(snapshot: QuotaSnapshot, config: AutoStartQuotaConfig): AutoStartWindowCandidate[] {
    const planned = new Set<string>();
    return snapshot.windows.flatMap((window, index) => {
      const enabled = window.durationMins === FIVE_HOUR_MINS
        ? config.fiveHour
        : window.durationMins === WEEK_MINS && config.weekly;
      if (!enabled || !hasQuotaWindowReset(window) || clamp(window.remainingRatio) < 1) {
        return [];
      }

      const id = historyIdentity(window);
      const resetAtMs = window.resetAt.getTime();
      const candidateKey = `${id}@${resetAtMs}`;
      if (this.historyEntry(id).pingAttemptedResetAtMs.has(resetAtMs) || planned.has(candidateKey)) {
        return [];
      }

      planned.add(candidateKey);
      return [{ id, row: quotaWindowLabel(window, index), resetAtMs }];
    });
  }

  private historyEntry(id: string): WindowHistoryEntry {
    const existing = this.windows.get(id);
    if (existing) {
      return existing;
    }

    const entry: WindowHistoryEntry = {
      resetObservationCounts: new Map(),
      pingAttemptedResetAtMs: new Set()
    };
    this.windows.set(id, entry);
    return entry;
  }
}

function historyIdentity(window: QuotaWindow): string {
  // Known durations survive source-slot and collision-count changes. Per-reset
  // history within that identity keeps simultaneous reset cycles independent.
  return window.durationMins !== undefined && Number.isFinite(window.durationMins) && window.durationMins > 0
    ? `duration:${window.durationMins}`
    : `slot:${window.id}`;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
