import type { QuotaWindow } from "./types.js";

export const FIVE_HOUR_MINS = 300;
export const WEEK_MINS = 10_080;
export type QuotaWindowWithReset = QuotaWindow & Required<Pick<QuotaWindow, "resetAt">>;
export type QuotaWindowWithTiming = QuotaWindowWithReset & Required<Pick<QuotaWindow, "durationMins">>;

const LABEL_UNITS = [
  { suffix: "Y", minutes: 525_600 },
  { suffix: "W", minutes: WEEK_MINS },
  { suffix: "D", minutes: 1_440 },
  { suffix: "H", minutes: 60 },
  { suffix: "M", minutes: 1 }
] as const;

export function quotaWindowLabel(window: QuotaWindow, index: number): string {
  const durationMins = window.durationMins;
  if (durationMins === WEEK_MINS) {
    return "WK";
  }

  if (durationMins !== undefined && Number.isFinite(durationMins) && durationMins > 0) {
    for (const unit of LABEL_UNITS) {
      const count = durationMins / unit.minutes;
      if (Number.isInteger(count) && count >= 1 && count <= 9) {
        return `${count}${unit.suffix}`;
      }
    }
  }

  return `Q${index + 1}`;
}

export function isLongQuotaWindow(window: QuotaWindow): boolean {
  return window.durationMins !== undefined
    && Number.isFinite(window.durationMins)
    && window.durationMins >= 1_440;
}

export function hasQuotaWindowReset(window: QuotaWindow): window is QuotaWindowWithReset {
  return window.resetAt !== undefined && Number.isFinite(window.resetAt.getTime());
}

export function hasQuotaWindowTiming(window: QuotaWindow): window is QuotaWindowWithTiming {
  return hasQuotaWindowReset(window)
    && window.durationMins !== undefined
    && Number.isFinite(window.durationMins)
    && window.durationMins > 0;
}
