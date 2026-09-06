import type { Plugin, PluginUpdate, Priority } from "../../orchestrator.js";
import type { VestaboardBoard, VestaboardBoardProvider } from "../../vestaboardTypes.js";
import { applyCodexQuotaDemo, type CodexQuotaDemoState } from "./demo.js";
import { formatError, formatQuota } from "./display/index.js";
import { isCodexAuthenticationFailure } from "./failure.js";
import {
  autoStartErrorStatus,
  bumpStatusPriority,
  errorStatus,
  logAutoStartFailure,
  logQuotaReadFailure,
  QuotaSnapshotCache,
  REFRESH_STATUS_MESSAGE_TTL_MS,
  TRANSIENT_STATUS_MESSAGE_TTL_MS,
  StatusMessageStack
} from "./pluginState.js";
import { QuotaWindowHistory } from "./quotaWindowHistory.js";
import type { ResetVisibility } from "./quotaWindowHistory.js";
import { createCodexQuotaPoller, readFixtureQuota } from "./quotaSource.js";
import type { CodexQuotaPluginOptions, Logger, QuotaPoller, QuotaSnapshot } from "./types.js";

export class CodexQuotaPlugin implements Plugin {
  readonly id = "codex-quota";
  readonly slug = "codex";
  private readonly quotaCache = new QuotaSnapshotCache();
  private readonly statusMessages = new StatusMessageStack();
  private readonly quotaWindowHistory: QuotaWindowHistory;
  private readonly demoDurationMs: number;
  private presentationDemo: CodexQuotaDemoState | undefined;
  private presentationDemoExpiresAt: Date | undefined;
  private collectionFailure: unknown;
  private pendingFailureLog: unknown;

  constructor(
    private readonly readQuota: QuotaPoller,
    private readonly options: {
      priority: Priority;
      errorPriority: Priority;
      timeZone?: string;
      showPacing?: boolean;
      board?: VestaboardBoardProvider;
      statusMessage?: () => string | undefined;
      takeDemoMode?: () => CodexQuotaDemoState | undefined;
      restoreDemoMode?: (demo: CodexQuotaDemoState) => void;
      logger?: Logger;
      now?: () => Date;
      quotaWindowHistory?: QuotaWindowHistory;
      demoDurationMs?: number;
    }
  ) {
    this.quotaWindowHistory = options.quotaWindowHistory ?? new QuotaWindowHistory();
    this.demoDurationMs = options.demoDurationMs ?? 0;
    if (!Number.isFinite(this.demoDurationMs) || this.demoDurationMs < 0) {
      throw new Error("Codex demo duration must be a non-negative number.");
    }
  }

  async getUpdate(): Promise<PluginUpdate> {
    await this.collect();
    return this.renderUpdate();
  }

  /**
   * Refreshes the in-memory quota ingredients without consuming a display demo.
   * Keeping this separate lets the runtime poll while a presentation override is
   * on the board and lets a later renderer reuse the same quota history/cache.
   */
  async collect(): Promise<void> {
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
      this.pushStatusMessages(now, statusMessage, sidecarError);
      this.collectionFailure = undefined;
      this.pendingFailureLog = undefined;
      const resetStatus = resetAvailableStatus(freshQuota, rateLimitResetCreditsAvailableCount);
      if (resetStatus) {
        this.statusMessages.pushLow(resetStatus, now, TRANSIENT_STATUS_MESSAGE_TTL_MS);
      }
      if (sidecarError) {
        logAutoStartFailure(this.options.logger, sidecarError);
      }
    } catch (error) {
      this.collectionFailure = error;
      this.pendingFailureLog = error;
      this.statusMessages.push(errorStatus(error), now, TRANSIENT_STATUS_MESSAGE_TTL_MS);
    }
  }

  /** Renders the most recently collected state, including current pacing time. */
  async renderUpdate({ consumeDemo = true }: { consumeDemo?: boolean } = {}): Promise<PluginUpdate> {
    const now = this.options.now?.() ?? new Date();
    const displayState = this.buildDisplayState(now, consumeDemo);
    const demoMode = displayState.presentationDemo;
    const board = await this.resolveBoard();
    const cachedQuota = this.quotaCache.snapshot();
    const displayStatusMessage = cachedQuota ? displayState.statusMessage : undefined;

    if (demoMode && this.collectionFailure !== undefined && !cachedQuota && this.demoDurationMs === 0) {
      this.options.restoreDemoMode?.(demoMode);
    }

    const renderedQuota = cachedQuota ? applyCodexQuotaDemo(cachedQuota, demoMode) : undefined;
    const message = cachedQuota
      ? formatQuota(renderedQuota!, {
          timeZone: displayState.timeZone,
          now,
          showPacing: displayState.showPacing,
          board,
          statusMessage: displayStatusMessage,
          staleWindowIds: displayState.staleWindowIds,
          resetVisibility: this.quotaWindowHistory.resetVisibilityFor(renderedQuota!)
        })
      : formatError(this.collectionFailure ?? new Error("Codex quota has not been collected yet."), {
          board,
          statusMessage: this.collectionFailure && isCodexAuthenticationFailure(this.collectionFailure)
            ? errorStatus(this.collectionFailure)
            : undefined
        });

    if (this.pendingFailureLog !== undefined) {
      logQuotaReadFailure(
        this.options.logger,
        this.pendingFailureLog,
        this.options.errorPriority,
        message,
        this.quotaCache.state()
      );
      this.pendingFailureLog = undefined;
    }

    return {
      priority: displayStatusMessage
        ? bumpStatusPriority(cachedQuota ? this.options.priority : this.options.errorPriority)
        : cachedQuota ? this.options.priority : this.options.errorPriority,
      message
    };
  }

  getDisplayState(now = this.options.now?.() ?? new Date()): CodexQuotaDisplayState {
    return this.buildDisplayState(now, true);
  }

  private buildDisplayState(now: Date, consumeDemo: boolean): CodexQuotaDisplayState {
    let currentDemo = this.presentationDemo;
    if (consumeDemo) {
      const queuedDemo = this.options.takeDemoMode?.();
      if (queuedDemo) {
        currentDemo = queuedDemo;
        if (this.demoDurationMs > 0) {
          this.presentationDemo = queuedDemo;
          this.presentationDemoExpiresAt = new Date(now.getTime() + this.demoDurationMs);
        } else {
          this.presentationDemo = undefined;
          this.presentationDemoExpiresAt = undefined;
        }
      }
    }
    if (this.presentationDemoExpiresAt && this.presentationDemoExpiresAt.getTime() <= now.getTime()) {
      this.presentationDemo = undefined;
      this.presentationDemoExpiresAt = undefined;
      currentDemo = undefined;
    }

    const snapshot = this.quotaCache.snapshot();
    return {
      snapshot,
      statusMessage: this.statusMessages.top(now) ?? this.options.statusMessage?.(),
      staleWindowIds: this.collectionFailure && snapshot ? snapshot.windows.map((window) => window.id) : [],
      resetVisibility: snapshot ? this.quotaWindowHistory.resetVisibilityFor(snapshot) : {},
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

  private async resolveBoard(): Promise<VestaboardBoard> {
    return this.options.board ? await this.options.board() : "note";
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
  priority = "normal",
  errorPriority = "low",
  timeZone,
  showPacing = true,
  autoStartWindow5h = false,
  autoStartWindowWk = false,
  board,
  statusMessage,
  takeDemoMode,
  restoreDemoMode,
  logger = console,
  now,
  demoDurationMs
}: CodexQuotaPluginOptions & {
  takeDemoMode?: () => CodexQuotaDemoState | undefined;
  restoreDemoMode?: (demo: CodexQuotaDemoState) => void;
  logger?: Logger;
  now?: () => Date;
  demoDurationMs?: number;
} = {}): CodexQuotaPlugin {
  const quotaWindowHistory = new QuotaWindowHistory();
  const readQuota: QuotaPoller = fixture
    ? async () => ({ snapshot: await readFixtureQuota() })
    : createCodexQuotaPoller({
        fiveHour: autoStartWindow5h,
        weekly: autoStartWindowWk
      }, quotaWindowHistory);
  return new CodexQuotaPlugin(readQuota, {
    priority,
    errorPriority,
    timeZone,
    showPacing,
    board,
    statusMessage,
    takeDemoMode,
    restoreDemoMode,
    logger,
    now,
    quotaWindowHistory,
    demoDurationMs
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
