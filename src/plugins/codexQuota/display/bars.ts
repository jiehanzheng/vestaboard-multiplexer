import type { QuotaWindow } from "../types.js";
import { hasQuotaWindowTiming, type QuotaWindowWithTiming } from "../quotaWindow.js";
import { BLANK, BLUE, charCode, clamp, GREEN, ORANGE, RED, WHITE, YELLOW } from "./shared.js";

export function quotaBar(window: QuotaWindow, now: Date, width: number, stale = false, showPacing = true): number[] {
  const remainingRatio = clamp(window.remainingRatio);
  const quotaBlocks = remainingRatio > 0
    ? Math.ceil(remainingRatio * width)
    : 0;
  const pacingWindow = hasQuotaWindowTiming(window) ? window : undefined;
  const fill = showPacing && pacingWindow ? pacingColor(pacingWindow, now) : GREEN;
  const bar = [
    ...Array(quotaBlocks).fill(fill),
    ...Array(width - quotaBlocks).fill(BLANK)
  ];

  if (showPacing) {
    if (pacingWindow) {
      const markerIndex = timeMarkerIndex(pacingWindow, now, width);
      bar[markerIndex] = WHITE;
    }
    const staleIndex = bar.findIndex((code) => code === BLANK);
    if (stale && staleIndex >= 0) {
      bar[staleIndex] = charCode("?");
    }
  }

  return bar;
}

export function barTextChar(code: number): string {
  if (code === GREEN) return "G";
  if (code === YELLOW) return "Y";
  if (code === ORANGE) return "O";
  if (code === RED) return "R";
  if (code === BLUE) return "B";
  if (code === WHITE) return "W";
  if (code === charCode("?")) return "?";
  return " ";
}

function pacingColor(window: QuotaWindowWithTiming, now: Date): number {
  const timeRatio = timeRemainingRatio(window, now);
  if (timeRatio <= 0) {
    return GREEN;
  }

  const paceRatio = clamp(window.remainingRatio) / timeRatio;
  if (paceRatio >= 1) return GREEN;
  if (paceRatio >= 0.85) return YELLOW;
  if (paceRatio >= 0.65) return ORANGE;
  return RED;
}

function timeMarkerIndex(window: QuotaWindowWithTiming, now: Date, width: number): number {
  return Math.min(width - 1, Math.max(0, Math.ceil(timeRemainingRatio(window, now) * width) - 1));
}

function timeRemainingRatio(window: QuotaWindowWithTiming, now: Date): number {
  const durationMs = window.durationMins * 60_000;
  return clamp((window.resetAt.getTime() - now.getTime()) / durationMs);
}
