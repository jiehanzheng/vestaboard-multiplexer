import type { Element, LayoutEntry } from "../../elements.js";
import type { VestaboardBoard, VestaboardBoardProvider } from "../../vestaboardTypes.js";
import { defaultCodexLayout } from "./elements.js";
import { createCodexQuotaPlugin, type CodexQuotaPlugin } from "./plugin.js";
import type { CodexConfig } from "./config.js";
import type { Logger, QuotaPoller } from "./types.js";

export interface CodexIntegrationDependencies {
  changed?: () => void;
  board?: VestaboardBoardProvider;
  now?: () => Date;
  logger?: Logger;
  readQuota?: QuotaPoller;
}

export interface CodexIntegration {
  readonly id: "codex-quota";
  readonly slug: "codex";
  readonly enabled: boolean;
  configure(config: CodexConfig): Promise<void>;
  start(): void;
  collectInitial(): Promise<void>;
  requestRefresh(): void;
  demo(): void;
  elements(draftConfig?: CodexConfig): Element[];
  defaultLayout(board: VestaboardBoard, draftConfig?: CodexConfig): LayoutEntry[];
  status(now?: Date): { error?: string; collectedAt?: string };
  loginStatus(): ReturnType<CodexQuotaPlugin["loginStatus"]>;
  loginAction(action: "start" | "cancel" | "check"): Promise<void> | void;
  stop(): Promise<void>;
}

export function createCodexIntegration(config: CodexConfig, dependencies: CodexIntegrationDependencies = {}): CodexIntegration {
  let current = config;
  let demoDrops = 0;
  let polling = false;
  const plugin = createCodexQuotaPlugin({
    fixture: config.source === "fixture",
    timeZone: config.timeZone,
    showPacing: config.showPacing,
    autoStartWindow5h: config.autoStartWindow5h,
    autoStartWindowWk: config.autoStartWindowWk,
    logger: dependencies.logger ?? console,
    now: dependencies.now,
    demoDurationMs: config.demoPauseMinutes * 60_000,
    onChanged: dependencies.changed,
    readQuota: dependencies.readQuota
  });

  return {
    id: "codex-quota" as const,
    slug: "codex" as const,
    get enabled() { return current.enabled; },
    async configure(next) {
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      const wasPolling = polling;
      if (wasPolling) await plugin.stopPolling();
      current = next;
      plugin.configure({
        fixture: next.source === "fixture",
        autoStartWindow5h: next.autoStartWindow5h,
        autoStartWindowWk: next.autoStartWindowWk,
        timeZone: next.timeZone,
        showPacing: next.showPacing,
        demoDurationMs: next.demoPauseMinutes * 60_000,
        now: dependencies.now,
        readQuota: dependencies.readQuota
      });
      dependencies.changed?.();
      if (wasPolling && next.enabled) void plugin.startPolling(next.pollIntervalSeconds * 1000, dependencies.changed);
    },
    start() {
      polling = true;
      if (current.enabled) void plugin.startPolling(current.pollIntervalSeconds * 1000, dependencies.changed);
    },
    async collectInitial() {
      if (!current.enabled) return;
      await plugin.collect();
      dependencies.changed?.();
    },
    requestRefresh() { plugin.requestPoll(); },
    demo() {
      plugin.activateDemo({ pctDrops: ++demoDrops });
    },
    elements(draftConfig = current) {
      const state = plugin.getDisplayState();
      const enabled = draftConfig.enabled ?? current.enabled;
      return plugin.elementsFor({
        snapshot: enabled ? state.snapshot : undefined,
        statusMessage: enabled ? state.statusMessage : undefined,
        timeZone: draftConfig.timeZone,
        ...(draftConfig.showPacing !== undefined ? { showPacing: draftConfig.showPacing } : {})
      }, state);
    },
    defaultLayout(board, draftConfig = current) {
      return (draftConfig.enabled ?? current.enabled) ? defaultCodexLayout(board) : [];
    },
    status(now) {
      const state = plugin.getDisplayState(now);
      return {
        ...(plugin.collectionError() ? { error: state.statusMessage ?? "Codex quota collection failed." } : {}),
        ...(plugin.collectedAt() ? { collectedAt: plugin.collectedAt()!.toISOString() } : {})
      };
    },
    loginStatus() { return plugin.loginStatus(); },
    loginAction(action) { return plugin.loginAction(action); },
    async stop() {
      polling = false;
      await plugin.stop();
    }
  };
}
