import type { QuotaSnapshot, QuotaWindow } from "./types.js";
import { FIVE_HOUR_MINS } from "./quotaWindow.js";

export type CodexQuotaDemoMode = "drop-1-pct" | "force-auto-start";

export interface CodexQuotaDemoState {
  pctDrops: number;
  forceAutoStart?: boolean;
}

export function applyCodexQuotaDemo(snapshot: QuotaSnapshot, demo: CodexQuotaDemoState | undefined): QuotaSnapshot {
  if (!demo) {
    return snapshot;
  }

  const fiveHourIndex = snapshot.windows.findIndex((window) => window.durationMins === FIVE_HOUR_MINS);
  if (fiveHourIndex < 0) {
    return snapshot;
  }

  return {
    windows: snapshot.windows.map((window, index) => index === fiveHourIndex
      ? { ...window, remainingRatio: applyDrops(window, demo) }
      : window)
  };
}

function applyDrops(window: QuotaWindow, demo: CodexQuotaDemoState): number {
  return clamp(window.remainingRatio - Math.max(0, demo.pctDrops) * 0.01);
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
