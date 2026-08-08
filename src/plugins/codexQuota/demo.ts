import type { QuotaSnapshot, QuotaWindow } from "./types.js";

export type CodexQuotaDemoMode = "drop-first-1-pct";

export interface CodexQuotaDemoState {
  pctDrops: number;
}

export function applyCodexQuotaDemo(snapshot: QuotaSnapshot, demo: CodexQuotaDemoState | undefined): QuotaSnapshot {
  if (!demo) {
    return snapshot;
  }

  if (snapshot.windows.length === 0) {
    return snapshot;
  }

  return {
    windows: snapshot.windows.map((window, index) => index === 0
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
