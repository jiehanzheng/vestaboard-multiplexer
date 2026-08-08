import type { CodexQuotaDemoMode, CodexQuotaDemoState } from "./plugins/codexQuota/demo.js";

export type RuntimeSignalAction = "refresh-now" | CodexQuotaDemoMode;

export class RuntimeSignalController {
  private demoPending = false;
  private refreshPending = false;
  private demoState: CodexQuotaDemoState = { pctDrops: 0 };
  private pauseAfterDemoRun = false;
  private wake: (() => void) | undefined;
  private readonly handlers = new Map<NodeJS.Signals, NodeJS.SignalsListener>();

  install(logger: Pick<Console, "info">): void {
    if (this.handlers.size > 0) {
      return;
    }

    // SIGHUP conventionally reloads a daemon; SIGUSR2 remains available for the explicit display demo.
    this.addHandler("SIGHUP", "refresh-now", logger);
    this.addHandler("SIGUSR2", "drop-first-1-pct", logger);
  }

  queue(action: RuntimeSignalAction, logger: Pick<Console, "info"> = console): void {
    if (action === "refresh-now") {
      this.refreshPending = true;
      logger.info("Queued immediate refresh for all widgets.");
    } else {
      this.demoState.pctDrops += 1;
      this.demoPending = true;
      logger.info(`Queued Codex quota demo: first-row drop=${this.demoState.pctDrops} percentage point(s).`);
    }

    this.wake?.();
  }

  uninstall(): void {
    for (const [signal, handler] of this.handlers) {
      process.off(signal, handler);
    }
    this.handlers.clear();
  }

  takeDemo(): CodexQuotaDemoState | undefined {
    if (!this.demoPending) {
      return undefined;
    }

    this.demoPending = false;
    this.pauseAfterDemoRun = true;
    return { ...this.demoState };
  }

  restoreDemo(demoState: CodexQuotaDemoState): void {
    this.demoState.pctDrops = Math.max(this.demoState.pctDrops, demoState.pctDrops);
    this.demoPending = true;
    this.pauseAfterDemoRun = true;
  }

  takePauseAfterDemoRun(): boolean {
    const pause = this.pauseAfterDemoRun;
    this.pauseAfterDemoRun = false;
    return pause;
  }

  sleep(ms: number): Promise<void> {
    if (this.takeWakeRequest()) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        if (this.wake === done) {
          this.wake = undefined;
        }
        this.takeWakeRequest();
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  private takeWakeRequest(): boolean {
    const requested = this.demoPending || this.refreshPending;
    // Refresh requests coalesce into the next full tick. Demo state remains pending until the Codex widget takes it.
    this.refreshPending = false;
    return requested;
  }

  private addHandler(
    signal: NodeJS.Signals,
    action: RuntimeSignalAction,
    logger: Pick<Console, "info">
  ): void {
    const handler = (): void => this.queue(action, logger);
    this.handlers.set(signal, handler);
    process.on(signal, handler);
  }
}
