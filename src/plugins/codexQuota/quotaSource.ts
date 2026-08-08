import { withCodexAppServer, type CodexAppServerClient, type RateLimitsResult, type RateWindow } from "./appServer.js";
import { CodexAutoStartSidecar, type AutoStartQuotaConfig } from "./autoStartSidecar.js";
import { CodexAuthRefreshError, isCodexAuthenticationFailure } from "./failure.js";
import { FIVE_HOUR_MINS, WEEK_MINS } from "./quotaWindow.js";
import { QuotaWindowHistory } from "./quotaWindowHistory.js";
import type { QuotaPollOptions, QuotaPoller, QuotaPollResult, QuotaSnapshot, QuotaWindow } from "./types.js";

export function createCodexQuotaPoller(autoStartConfig: AutoStartQuotaConfig, history = new QuotaWindowHistory()): QuotaPoller {
  const autoStartSidecar = new CodexAutoStartSidecar(autoStartConfig, history);
  return async (options: QuotaPollOptions = {}) => readCodexQuotaWithSidecar(autoStartSidecar, options);
}

export async function readCodexQuota(): Promise<QuotaSnapshot> {
  return withCodexAppServer(async (client) => {
    const rateLimits = await readRateLimitsWithAuthRecovery(client);
    return quotaFromRateLimits(rateLimits);
  });
}

export async function readRateLimits(): Promise<RateLimitsResult> {
  return withCodexAppServer(readRateLimitsWithAuthRecovery);
}

export async function readRateLimitsWithAuthRecovery(client: CodexAppServerClient): Promise<RateLimitsResult> {
  try {
    return await client.readRateLimits();
  } catch (initialError) {
    if (!isCodexAuthenticationFailure(initialError)) {
      throw initialError;
    }

    try {
      // A single explicit refresh recovers stale access tokens without creating an unbounded retry loop.
      await client.readAccount({ refreshToken: true });
    } catch (refreshError) {
      throw new CodexAuthRefreshError(initialError, refreshError);
    }

    return client.readRateLimits();
  }
}

export function quotaFromRateLimits(result: RateLimitsResult): QuotaSnapshot {
  return {
    windows: [
      quotaWindow("primary", result.rateLimits?.primary),
      quotaWindow("secondary", result.rateLimits?.secondary)
    ]
      .filter((window): window is QuotaWindow => window !== undefined)
      .sort(compareQuotaWindows)
  };
}

export async function readFixtureQuota(): Promise<QuotaSnapshot> {
  const now = new Date();
  return {
    windows: [
      {
        id: "primary",
        remainingRatio: 0.76,
        resetAt: new Date(now.getTime() + FIVE_HOUR_MINS * 60_000),
        durationMins: FIVE_HOUR_MINS
      },
      {
        id: "secondary",
        remainingRatio: 0.44,
        resetAt: nextMonday(now),
        durationMins: WEEK_MINS
      }
    ]
  };
}

async function readCodexQuotaWithSidecar(
  autoStartSidecar: CodexAutoStartSidecar,
  options: QuotaPollOptions
): Promise<QuotaPollResult> {
  return withCodexAppServer(async (client) => {
    const rateLimits = await readRateLimitsWithAuthRecovery(client);
    const snapshot = quotaFromRateLimits(rateLimits);
    const rateLimitResetCreditsAvailableCount = resetCreditsAvailableCount(rateLimits);
    try {
      const autoStart = await autoStartSidecar.afterQuotaRead({
        client,
        snapshot,
        force: options.forceAutoStart === true,
        now: options.now ?? new Date()
      });

      return {
        snapshot,
        statusMessage: autoStart.statusMessage,
        rateLimitResetCreditsAvailableCount
      };
    } catch (sidecarError) {
      return {
        snapshot,
        sidecarError,
        rateLimitResetCreditsAvailableCount
      };
    }
  });
}

function resetCreditsAvailableCount(result: RateLimitsResult): number | undefined {
  const availableCount = result.rateLimitResetCredits?.availableCount;
  return typeof availableCount === "number" && Number.isFinite(availableCount) ? availableCount : undefined;
}

function quotaWindow(id: string, window: RateWindow | null | undefined): QuotaWindow | undefined {
  if (!window || !Number.isFinite(window.usedPercent)) {
    return undefined;
  }

  return {
    id,
    remainingRatio: clamp((100 - window.usedPercent) / 100),
    durationMins: positiveFinite(window.windowDurationMins),
    resetAt: unixDate(window.resetsAt)
  };
}

function compareQuotaWindows(left: QuotaWindow, right: QuotaWindow): number {
  if (left.durationMins === undefined) return right.durationMins === undefined ? 0 : 1;
  if (right.durationMins === undefined) return -1;
  return left.durationMins - right.durationMins;
}

function positiveFinite(value: number | null | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function unixDate(value: number | null | undefined): Date | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function nextMonday(date: Date): Date {
  const reset = new Date(date);
  reset.setDate(reset.getDate() + (reset.getDay() === 0 ? 1 : 8 - reset.getDay()));
  reset.setHours(0, 0, 0, 0);
  return reset;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}
