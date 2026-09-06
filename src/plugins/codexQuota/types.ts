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
  timeZone?: string;
  autoStartWindow5h?: boolean;
  autoStartWindowWk?: boolean;
  showPacing?: boolean;
  statusMessage?: () => string | undefined;
  changed?: () => void;
}
