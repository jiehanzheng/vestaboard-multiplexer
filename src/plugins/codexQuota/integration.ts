import type { Element, LayoutEntry } from "../../elements.js";
import type { VestaboardBoard } from "../../vestaboardTypes.js";
import { defaultCodexLayout } from "./elements.js";
import { createCodexQuotaPlugin, type CodexQuotaPlugin } from "./plugin.js";
import type { CodexConfig } from "./config.js";
import type { Logger, QuotaPoller } from "./types.js";

export interface CodexIntegrationDependencies {
  changed?: () => void;
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
  elements(draftConfig?: CodexConfig): Element[];
  defaultLayout(board: VestaboardBoard, draftConfig?: CodexConfig): LayoutEntry[];
  status(now?: Date): { error?: string; collectedAt?: string };
  loginStatus(): ReturnType<CodexQuotaPlugin["loginStatus"]>;
  loginAction(action: "start" | "cancel" | "check"): Promise<void> | void;
  stop(): Promise<void>;
}

export function createCodexIntegration(config: CodexConfig, dependencies: CodexIntegrationDependencies = {}): CodexIntegration {
  let current = config;
  let polling = false;
  let stopped = false;
  let stopTask: Promise<void> | undefined;
  const plugin = createCodexQuotaPlugin({
    fixture: config.source === "fixture",
    timeZone: config.timeZone,
    showPacing: config.showPacing,
    autoStartWindow5h: config.autoStartWindow5h,
    autoStartWindowWk: config.autoStartWindowWk,
    logger: dependencies.logger ?? console,
    windowLabels: [config.window1Label, config.window2Label],
    now: dependencies.now,
    changed: dependencies.changed,
    readQuota: dependencies.readQuota
  });

  return {
    id: "codex-quota" as const,
    slug: "codex" as const,
    get enabled() { return current.enabled; },
    async configure(next) {
      if (stopped) return;
      if (JSON.stringify(next) === JSON.stringify(current)) return;
      const wasPolling = polling;
      if (wasPolling) await plugin.stopPolling();
      if (stopped) return;
      current = next;
      plugin.configure({
        fixture: next.source === "fixture",
        autoStartWindow5h: next.autoStartWindow5h,
        autoStartWindowWk: next.autoStartWindowWk,
        timeZone: next.timeZone,
        showPacing: next.showPacing,
        windowLabels: [next.window1Label, next.window2Label],
        now: dependencies.now,
        readQuota: dependencies.readQuota
      });
      dependencies.changed?.();
      if (wasPolling && next.enabled) void plugin.startPolling(next.pollIntervalSeconds * 1000, dependencies.changed);
    },
    start() {
      if (stopped) return;
      polling = true;
      if (current.enabled) void plugin.startPolling(current.pollIntervalSeconds * 1000, dependencies.changed);
    },
    async collectInitial() {
      if (stopped || !current.enabled) return;
      await plugin.collect();
      dependencies.changed?.();
    },
    elements(draftConfig = current) {
      const state = plugin.getDisplayState();
      const enabled = draftConfig.enabled ?? current.enabled;
      return plugin.elementsFor({
        snapshot: enabled ? state.snapshot : undefined,
        statusMessage: enabled ? state.statusMessage : undefined,
        timeZone: draftConfig.timeZone,
        ...(draftConfig.showPacing !== undefined ? { showPacing: draftConfig.showPacing } : {}),
        windowLabels: [draftConfig.window1Label, draftConfig.window2Label]
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
      if (stopTask) {
        await stopTask;
        return;
      }
      stopped = true;
      polling = false;
      stopTask = plugin.stop();
      await stopTask;
    }
  };
}
