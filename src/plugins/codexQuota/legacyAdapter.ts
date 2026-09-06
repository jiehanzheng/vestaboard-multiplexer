import type { Plugin, PluginUpdate, Priority } from "../../orchestrator.js";
import { priorityValue } from "../../priority.js";
import { composeElements } from "../../elements.js";
import type { VestaboardBoard, VestaboardBoardProvider } from "../../vestaboardTypes.js";
import { formatError } from "./display/index.js";
import { createCodexElements, defaultCodexLayout } from "./elements.js";
import { isCodexAuthenticationFailure } from "./failure.js";
import { errorStatus } from "./pluginState.js";
import { createCodexQuotaPlugin, type CodexQuotaDisplayState, type CodexQuotaPlugin } from "./plugin.js";
import type { QuotaPoller } from "./types.js";

/**
 * Compatibility boundary for the original daemon. It is intentionally small:
 * the daemon still owns priority selection and delivery until the atomic
 * application cutover, while collection and cached ingredients already belong
 * to the final Codex plugin.
 */
export class LegacyCodexQuotaAdapter implements Plugin {
  readonly id = "codex-quota";
  readonly slug = "codex";
  private readonly plugin: CodexQuotaPlugin;

  constructor(private readonly options: {
    priority: Priority;
    errorPriority: Priority;
    board?: VestaboardBoardProvider;
    statusMessage?: () => string | undefined;
    logger?: Pick<Console, "warn">;
    now?: () => Date;
    fixture?: boolean;
    timeZone?: string;
    showPacing?: boolean;
    autoStartWindow5h?: boolean;
    autoStartWindowWk?: boolean;
    readQuota?: QuotaPoller;
  }) {
    this.plugin = createCodexQuotaPlugin({
      fixture: options.fixture,
      timeZone: options.timeZone,
      showPacing: options.showPacing,
      statusMessage: options.statusMessage,
      autoStartWindow5h: options.autoStartWindow5h,
      autoStartWindowWk: options.autoStartWindowWk,
      logger: options.logger,
      now: options.now,
      readQuota: options.readQuota
    });
  }

  async getUpdate(): Promise<PluginUpdate> {
    const now = this.options.now?.() ?? new Date();
    const board = this.options.board ? await this.options.board() : "note";
    await this.plugin.collect();
    const error = this.plugin.collectionError();
    const state: CodexQuotaDisplayState = this.plugin.getDisplayState(now);
    const displayStatus = state.statusMessage ?? this.options.statusMessage?.();
    const snapshot = state.snapshot;
    const message = snapshot
      ? composeElements(
          createCodexElements(() => state, () => now),
          defaultCodexLayout(board),
          board === "flagship" ? { width: 22, height: 6 } : { width: 15, height: 3 }
        )
      : formatError(error ?? new Error("Codex quota is unavailable."), {
          // Keep the daemon's established no-cache error frame until the
          // atomic runtime cutover replaces this compatibility adapter.
          board,
          statusMessage: error && isCodexAuthenticationFailure(error) ? errorStatus(error) : undefined
        });
    const priority = error ? this.options.errorPriority : this.options.priority;
    return {
      priority: snapshot && displayStatus ? bumpPriority(priority) : priority,
      message
    };
  }
}

function bumpPriority(priority: Priority): Priority {
  return priorityValue(priority) >= priorityValue("high") ? priority : "high";
}
