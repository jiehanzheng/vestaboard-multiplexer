import type { Priority } from "../../orchestrator.js";
import type { VestaboardBoardProvider } from "../../vestaboardTypes.js";

export interface QuotaSnapshot {
  windows: QuotaWindow[];
}

export interface QuotaWindow {
  id: string;
  remainingRatio: number;
  durationMins?: number;
  resetAt?: Date;
}

export interface QuotaPollOptions {
  forceAutoStart?: boolean;
  now?: Date;
}

export interface QuotaPollResult {
  snapshot: QuotaSnapshot;
  statusMessage?: string;
  sidecarError?: unknown;
  rateLimitResetCreditsAvailableCount?: number;
}

export type QuotaPoller = (options?: QuotaPollOptions) => Promise<QuotaPollResult>;
export type Logger = Pick<Console, "warn">;

export interface CodexQuotaPluginOptions {
  fixture?: boolean;
  priority?: Priority;
  errorPriority?: Priority;
  timeZone?: string;
  autoStartWindow5h?: boolean;
  autoStartWindowWk?: boolean;
  showPacing?: boolean;
  board?: VestaboardBoardProvider;
  statusMessage?: () => string | undefined;
}
