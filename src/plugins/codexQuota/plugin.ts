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
import { createCodexQuotaPoller, readFixtureQuota } from "./quotaSource.js";
import type { CodexQuotaPluginOptions, Logger, QuotaPoller, QuotaSnapshot } from "./types.js";

export class CodexQuotaPlugin implements Plugin {
  readonly id = "codex-quota";
  readonly slug = "codex";
  private readonly quotaCache = new QuotaSnapshotCache();
  private readonly statusMessages = new StatusMessageStack();
  private readonly quotaWindowHistory: QuotaWindowHistory;

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
    }
  ) {
    this.quotaWindowHistory = options.quotaWindowHistory ?? new QuotaWindowHistory();
  }

  async getUpdate(): Promise<PluginUpdate> {
    const now = this.options.now?.() ?? new Date();
    const demoMode = this.options.takeDemoMode?.();
    const board = await this.resolveBoard();

    try {
      const {
        snapshot: freshQuota,
        statusMessage,
        sidecarError,
        rateLimitResetCreditsAvailableCount
      } = await this.readQuota({ forceAutoStart: demoMode?.forceAutoStart, now });
      this.quotaWindowHistory.recordFreshSnapshot(freshQuota);
      this.quotaCache.update(freshQuota, now);
      this.pushStatusMessages(now, statusMessage, sidecarError);
      const resetStatus = resetAvailableStatus(freshQuota, rateLimitResetCreditsAvailableCount);
      if (resetStatus) {
        this.statusMessages.pushLow(resetStatus, now, TRANSIENT_STATUS_MESSAGE_TTL_MS);
      }
      if (sidecarError) {
        logAutoStartFailure(this.options.logger, sidecarError);
      }

      const displayStatusMessage = this.statusMessages.top(now) ?? this.options.statusMessage?.();
      const renderedQuota = applyCodexQuotaDemo(freshQuota, demoMode);
      const message = formatQuota(renderedQuota, {
        timeZone: this.options.timeZone,
        now,
        showPacing: this.options.showPacing,
        board,
        statusMessage: displayStatusMessage,
        resetVisibility: this.quotaWindowHistory.resetVisibilityFor(renderedQuota)
      });

      return {
        priority: displayStatusMessage ? bumpStatusPriority(this.options.priority) : this.options.priority,
        message
      };
    } catch (error) {
      if (demoMode) {
        this.options.restoreDemoMode?.(demoMode);
      }
      return this.fallbackUpdate(error, now, board);
    }
  }

  private fallbackUpdate(error: unknown, now: Date, board: VestaboardBoard): PluginUpdate {
    const cachedQuota = this.quotaCache.snapshot();
    const failureStatus = errorStatus(error);
    this.statusMessages.push(failureStatus, now, TRANSIENT_STATUS_MESSAGE_TTL_MS);
    const displayStatusMessage = cachedQuota ? this.statusMessages.top(now) : undefined;
    const message = cachedQuota
      ? formatQuota(cachedQuota, {
          timeZone: this.options.timeZone,
          now,
          showPacing: this.options.showPacing,
          board,
          statusMessage: displayStatusMessage,
          staleWindowIds: cachedQuota.windows.map((window) => window.id),
          resetVisibility: this.quotaWindowHistory.resetVisibilityFor(cachedQuota)
        })
      : formatError(error, {
          board,
          statusMessage: isCodexAuthenticationFailure(error) ? failureStatus : undefined
        });
    logQuotaReadFailure(this.options.logger, error, this.options.errorPriority, message, this.quotaCache.state());

    return {
      priority: displayStatusMessage ? bumpStatusPriority(this.options.errorPriority) : this.options.errorPriority,
      message
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
  now
}: CodexQuotaPluginOptions & {
  takeDemoMode?: () => CodexQuotaDemoState | undefined;
  restoreDemoMode?: (demo: CodexQuotaDemoState) => void;
  logger?: Logger;
  now?: () => Date;
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
    quotaWindowHistory
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
