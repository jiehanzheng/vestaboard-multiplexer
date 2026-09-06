import type { Plugin, PluginUpdate, Priority } from "../../orchestrator.js";
import { priorityValue } from "../../priority.js";
import type { VestaboardBoard, VestaboardBoardProvider } from "../../vestaboardTypes.js";
import type { CodexQuotaDemoState } from "./demo.js";
import { formatError, formatQuota } from "./display/index.js";
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
    takeDemoMode?: () => CodexQuotaDemoState | undefined;
    restoreDemoMode?: (demo: CodexQuotaDemoState) => void;
    logger?: Pick<Console, "warn">;
    now?: () => Date;
    fixture?: boolean;
    timeZone?: string;
    showPacing?: boolean;
    autoStartWindow5h?: boolean;
    autoStartWindowWk?: boolean;
    demoDurationMs?: number;
    readQuota?: QuotaPoller;
  }) {
    this.plugin = createCodexQuotaPlugin({
      fixture: options.fixture,
      timeZone: options.timeZone,
      showPacing: options.showPacing,
      autoStartWindow5h: options.autoStartWindow5h,
      autoStartWindowWk: options.autoStartWindowWk,
      logger: options.logger,
      now: options.now,
      demoDurationMs: options.demoDurationMs,
      readQuota: options.readQuota
    });
  }

  async getUpdate(): Promise<PluginUpdate> {
    const now = this.options.now?.() ?? new Date();
    const board = this.options.board ? await this.options.board() : "note";
    const demo = this.options.takeDemoMode?.();
    await this.plugin.collect();
    const error = this.plugin.collectionError();
    let state: CodexQuotaDisplayState;
    if (error) {
      if (demo) this.options.restoreDemoMode?.(demo);
      state = this.plugin.getDisplayState(now);
    } else if (demo) {
      // The old daemon consumes one demo per update; let the final plugin own
      // the adjusted snapshot and reset history, then neutralize the state for
      // the next legacy call without persisting a presentation override.
      this.plugin.activateDemo(demo, now);
      state = this.plugin.getDisplayState(now);
      this.plugin.activateDemo({ pctDrops: 0 }, now);
    } else {
      state = this.plugin.getDisplayState(now);
    }
    const displayStatus = state.statusMessage ?? this.options.statusMessage?.();
    const snapshot = state.snapshot;
    const message = snapshot
      ? formatQuota(snapshot, {
          board,
          timeZone: state.timeZone,
          now,
          showPacing: state.showPacing,
          statusMessage: displayStatus,
          staleWindowIds: state.staleWindowIds,
          resetVisibility: state.resetVisibility
        })
      : formatError(error ?? new Error("Codex quota is unavailable."), {
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
