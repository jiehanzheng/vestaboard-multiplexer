import type { Element } from "../../elements.js";
import { CollectionController } from "../../runtime/collection.js";
import { CodexLogin } from "./login.js";
import { applyCodexQuotaDemo, type CodexQuotaDemoState } from "./demo.js";
import { formatError } from "./display/index.js";
import {
  autoStartErrorStatus,
  errorStatus,
  logAutoStartFailure,
  logQuotaReadFailure,
  QuotaSnapshotCache,
  REFRESH_STATUS_MESSAGE_TTL_MS,
  TRANSIENT_STATUS_MESSAGE_TTL_MS,
  StatusMessageStack
} from "./pluginState.js";
import { isCodexAuthenticationFailure } from "./failure.js";
import { QuotaWindowHistory } from "./quotaWindowHistory.js";
import type { ResetVisibility } from "./quotaWindowHistory.js";
import { createCodexQuotaPoller, readFixtureQuota } from "./quotaSource.js";
import { createCodexElements } from "./elements.js";
import type { CodexQuotaPluginOptions, Logger, QuotaPoller, QuotaSnapshot } from "./types.js";

export class CodexQuotaPlugin {
  readonly id = "codex-quota";
  readonly slug = "codex";
  private quotaCache = new QuotaSnapshotCache();
  private statusMessages = new StatusMessageStack();
  private quotaWindowHistory: QuotaWindowHistory;
  private sourceFixture: boolean | undefined;
  private demoDurationMs: number;
  private presentationDemo: CodexQuotaDemoState | undefined;
  private presentationDemoExpiresAt: Date | undefined;
  private collectionFailure: unknown;
  private lastCollectedAt: Date | undefined;
  private collectTask: Promise<void> | undefined;
  private readonly login: CodexLogin;
  private collection?: CollectionController;

  constructor(
    private readQuota: QuotaPoller,
    private readonly options: {
      timeZone?: string;
      showPacing?: boolean;
      statusMessage?: () => string | undefined;
      logger?: Logger;
      now?: () => Date;
      quotaWindowHistory?: QuotaWindowHistory;
      fixture?: boolean;
      demoDurationMs?: number;
      onChanged?: () => void;
    }
  ) {
    this.quotaWindowHistory = options.quotaWindowHistory ?? new QuotaWindowHistory();
    this.sourceFixture = options.fixture;
    this.demoDurationMs = options.demoDurationMs ?? 0;
    if (!Number.isFinite(this.demoDurationMs) || this.demoDurationMs < 0) {
      throw new Error("Codex demo duration must be a non-negative number.");
    }
    this.login = new CodexLogin(() => this.options.onChanged?.());
  }

  configure(options: {
    fixture?: boolean;
    autoStartWindow5h?: boolean;
    autoStartWindowWk?: boolean;
    timeZone?: string;
    showPacing?: boolean;
    demoDurationMs?: number;
    now?: () => Date;
    readQuota?: QuotaPoller;
  }): void {
    const sourceChanged = options.fixture !== undefined
      && this.sourceFixture !== undefined
      && options.fixture !== this.sourceFixture;
    if (sourceChanged) {
      this.quotaCache = new QuotaSnapshotCache();
      this.statusMessages = new StatusMessageStack();
      this.quotaWindowHistory = new QuotaWindowHistory();
      this.collectionFailure = undefined;
      this.lastCollectedAt = undefined;
    }
    if (options.fixture !== undefined) this.sourceFixture = options.fixture;
    if (options.readQuota) {
      this.readQuota = options.readQuota;
    } else if (options.fixture !== undefined || options.autoStartWindow5h !== undefined || options.autoStartWindowWk !== undefined) {
      this.readQuota = options.fixture
        ? async () => ({ snapshot: await readFixtureQuota() })
        : createCodexQuotaPoller({
            fiveHour: options.autoStartWindow5h ?? false,
            weekly: options.autoStartWindowWk ?? false
          }, this.quotaWindowHistory);
    }
    if ("timeZone" in options) this.options.timeZone = options.timeZone;
    if ("showPacing" in options && options.showPacing !== undefined) this.options.showPacing = options.showPacing;
    if ("now" in options) this.options.now = options.now;
    if (options.demoDurationMs !== undefined) {
      if (!Number.isFinite(options.demoDurationMs) || options.demoDurationMs < 0) throw new Error("Codex demo duration must be a non-negative number.");
      this.demoDurationMs = options.demoDurationMs;
    }
  }

  startPolling(intervalMs: number, onCollected?: () => Promise<void> | void): Promise<void> {
    if (!this.collection) {
      this.collection = new CollectionController({
        intervalMs,
        collect: () => this.collect(),
        onCollected
      });
    } else {
      this.collection.setInterval(intervalMs);
    }
    return this.collection.start();
  }

  stopPolling(): Promise<void> {
    return this.collection?.stop() ?? Promise.resolve();
  }

  requestPoll(): void { this.collection?.requestNow(); }

  setPollInterval(intervalMs: number): void {
    if (!this.collection) return;
    this.collection.setInterval(intervalMs);
  }

  collectionStatus(): ReturnType<CollectionController["status"]> | undefined {
    return this.collection?.status();
  }

  collectionError(): unknown {
    return this.collectionFailure;
  }

  collectedAt(): Date | undefined {
    return this.lastCollectedAt ? new Date(this.lastCollectedAt) : undefined;
  }

  loginStatus() { return this.login.status(); }

  loginAction(action: "start" | "cancel" | "check"): Promise<void> | void {
    if (action === "start") return this.login.start();
    if (action === "cancel") return this.login.cancel();
    return this.login.check();
  }

  async stop(): Promise<void> {
    await Promise.all([this.stopPolling(), this.login.stop(), this.collectTask]);
  }

  activateDemo(demo: CodexQuotaDemoState, now = this.options.now?.() ?? new Date()): void {
    this.presentationDemo = { ...demo };
    this.presentationDemoExpiresAt = this.demoDurationMs > 0
      ? new Date(now.getTime() + this.demoDurationMs)
      : undefined;
    this.options.onChanged?.();
  }

  /**
   * Refreshes the in-memory quota ingredients without consuming a display demo.
   * Keeping this separate lets the runtime poll while a presentation override is
   * on the board and lets a later renderer reuse the same quota history/cache.
   */
  async collect(): Promise<void> {
    if (this.collectTask) return this.collectTask;
    let task!: Promise<void>;
    task = this.collectImpl().finally(() => {
      if (this.collectTask === task) this.collectTask = undefined;
    });
    this.collectTask = task;
    return task;
  }

  private async collectImpl(): Promise<void> {
    const now = this.options.now?.() ?? new Date();
    try {
      const {
        snapshot: freshQuota,
        statusMessage,
        sidecarError,
        rateLimitResetCreditsAvailableCount
      } = await this.readQuota({ now });
      this.quotaWindowHistory.recordFreshSnapshot(freshQuota);
      this.quotaCache.update(freshQuota, now);
      this.lastCollectedAt = new Date(now);
      this.pushStatusMessages(now, statusMessage, sidecarError);
      this.collectionFailure = undefined;
      const resetStatus = resetAvailableStatus(freshQuota, rateLimitResetCreditsAvailableCount);
      if (resetStatus) {
        this.statusMessages.pushLow(resetStatus, now, TRANSIENT_STATUS_MESSAGE_TTL_MS);
      }
      if (sidecarError) {
        logAutoStartFailure(this.options.logger, sidecarError);
      }
    } catch (error) {
      this.collectionFailure = error;
      this.statusMessages.push(errorStatus(error), now, TRANSIENT_STATUS_MESSAGE_TTL_MS);
      logQuotaReadFailure(
        this.options.logger,
        error,
        formatError(error, {
          statusMessage: isCodexAuthenticationFailure(error) ? errorStatus(error) : undefined
        }),
        this.quotaCache.state()
      );
    }
  }

  getDisplayState(now = this.options.now?.() ?? new Date()): CodexQuotaDisplayState {
    return this.buildDisplayState(now);
  }

  /** Captures one immutable ingredient set for every element in a composition. */
  elementsFor(
    overrides: Partial<Pick<CodexQuotaDisplayState, "snapshot" | "statusMessage" | "timeZone" | "showPacing">> = {},
    captured = this.getDisplayState()
  ): Element[] {
    const current = captured;
    const state: CodexQuotaDisplayState = { ...current, ...overrides };
    return createCodexElements(() => state, () => this.options.now?.() ?? new Date());
  }

  private buildDisplayState(now: Date): CodexQuotaDisplayState {
    let currentDemo = this.presentationDemo;
    if (this.presentationDemoExpiresAt && this.presentationDemoExpiresAt.getTime() <= now.getTime()) {
      currentDemo = undefined;
    }

    const snapshot = this.quotaCache.snapshot();
    const displayedSnapshot = snapshot ? applyCodexQuotaDemo(snapshot, currentDemo) : undefined;
    return {
      snapshot: displayedSnapshot,
      statusMessage: this.statusMessages.top(now) ?? this.options.statusMessage?.(),
      staleWindowIds: this.collectionFailure && snapshot ? snapshot.windows.map((window) => window.id) : [],
      resetVisibility: displayedSnapshot ? this.quotaWindowHistory.resetVisibilityFor(displayedSnapshot) : {},
      timeZone: this.options.timeZone,
      showPacing: this.options.showPacing ?? true,
      ...(currentDemo ? { presentationDemo: { ...currentDemo } } : {})
    };
  }

  private pushStatusMessages(
    now: Date,
    statusMessage: string | undefined,
    sidecarError: unknown
  ): void {
    if (statusMessage) {
      this.statusMessages.push(statusMessage, now, REFRESH_STATUS_MESSAGE_TTL_MS);
    }

    if (sidecarError) {
      this.statusMessages.push(autoStartErrorStatus(), now, TRANSIENT_STATUS_MESSAGE_TTL_MS);
    }
  }

}

export interface CodexQuotaDisplayState {
  snapshot?: QuotaSnapshot;
  statusMessage?: string;
  staleWindowIds: string[];
  resetVisibility: ResetVisibility;
  timeZone?: string;
  showPacing: boolean;
  presentationDemo?: CodexQuotaDemoState;
}

export function createCodexQuotaPlugin({
  fixture = false,
  timeZone,
  showPacing = true,
  autoStartWindow5h = false,
  autoStartWindowWk = false,
  statusMessage,
    logger = console,
    now,
  demoDurationMs,
  onChanged,
  readQuota
}: CodexQuotaPluginOptions & {
  logger?: Logger;
  now?: () => Date;
  demoDurationMs?: number;
  onChanged?: () => void;
  readQuota?: QuotaPoller;
  } = {}): CodexQuotaPlugin {
  const quotaWindowHistory = new QuotaWindowHistory();
  const quotaReader: QuotaPoller = readQuota ?? (fixture
    ? async () => ({ snapshot: await readFixtureQuota() })
    : createCodexQuotaPoller({
        fiveHour: autoStartWindow5h,
        weekly: autoStartWindowWk
      }, quotaWindowHistory));
  return new CodexQuotaPlugin(quotaReader, {
    timeZone,
    showPacing,
    statusMessage,
    logger,
    now,
    quotaWindowHistory,
    fixture,
    demoDurationMs,
    onChanged
  });
}

function resetAvailableStatus(snapshot: QuotaSnapshot, availableCount: number | undefined): string | undefined {
  if ((availableCount ?? 0) <= 0) {
    return undefined;
  }

  return snapshot.windows.slice(0, 2).some((window) => window.remainingRatio <= 0)
    ? "reset available"
    : undefined;
}
