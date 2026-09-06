import type { PluginUpdate, VestaboardMessage } from "../orchestrator.js";
import { CollectionController } from "./collection.js";
import { DeliveryController, type DeliveryAttempt, type DeliveryStatus } from "./delivery.js";

export interface RuntimeStatus {
  running: boolean;
  collection: ReturnType<CollectionController["status"]>;
  delivery: DeliveryStatus;
}

export interface RuntimeControllerOptions {
  collect: CollectionController;
  delivery: DeliveryController;
  render: () => Promise<PluginUpdate>;
  startup: () => Promise<VestaboardMessage>;
  startupHoldMs: number;
  sleep?: (ms: number) => Promise<void>;
  wake?: () => void;
  now?: () => Date;
  afterSleep?: () => void;
  waitOverride?: (defaultMs: number, attempt: DeliveryAttempt) => number;
  logger?: Pick<Console, "warn">;
}

/** Coordinates independent collection with centrally limited presentation. */
export class RuntimeController {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: Pick<Console, "warn">;
  private readonly now: () => Date;
  private running = false;
  private stopRequested = false;
  private runPromise: Promise<void> | undefined;

  constructor(private readonly options: RuntimeControllerOptions) {
    if (!Number.isFinite(options.startupHoldMs) || options.startupHoldMs < 0) {
      throw new Error("Startup hold must be a non-negative number.");
    }
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => new Date());
  }

  start(): Promise<void> {
    if (this.runPromise) return this.runPromise;
    this.stopRequested = false;
    this.running = true;
    void this.options.collect.start();
    this.runPromise = this.run().catch(async (error) => {
      this.stopRequested = true;
      await this.options.delivery.stop();
      await this.options.collect.stop();
      throw error;
    }).finally(() => {
      this.running = false;
      this.runPromise = undefined;
    });
    return this.runPromise;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.running = false;
    await this.options.delivery.stop();
    this.options.wake?.();
    await this.options.collect.stop();
    await this.runPromise;
  }

  status(): RuntimeStatus {
    return {
      running: this.running,
      collection: this.options.collect.status(),
      delivery: this.options.delivery.status()
    };
  }

  private async run(): Promise<void> {
    const startup = await this.options.startup();
    if (this.stopRequested) return;

    await this.options.delivery.deliverStartup(startup, this.options.startupHoldMs);
    while (!this.stopRequested) {
      await this.waitUntilAttemptReady();
      if (this.stopRequested) break;
      const attempt = await this.renderAndAttempt();
      if (this.stopRequested) break;

      const status = this.options.delivery.status();
      const now = this.now().getTime();
      const nextAttemptAt = status.nextAttemptAt?.getTime() ?? now;
      const defaultWaitMs = status.nextAttemptAt
        ? Math.max(0, nextAttemptAt - now)
        : status.lastOutcome === "empty" || status.lastOutcome === "unchanged" || status.lastOutcome === "paused"
          ? status.intervalMs
          : 0;
      const waitMs = this.options.waitOverride?.(defaultWaitMs, attempt) ?? defaultWaitMs;
      await this.sleep(waitMs);
      this.options.afterSleep?.();
    }
  }

  private async waitUntilAttemptReady(): Promise<void> {
    while (!this.stopRequested) {
      const nextAttemptAt = this.options.delivery.status().nextAttemptAt?.getTime();
      if (nextAttemptAt === undefined) return;
      const waitMs = Math.max(0, nextAttemptAt - this.now().getTime());
      if (waitMs === 0) return;
      await this.sleep(waitMs);
      this.options.afterSleep?.();
    }
  }

  private async renderAndAttempt(): Promise<DeliveryAttempt> {
    try {
      const update = await this.options.render();
      this.options.delivery.updateFrame(update.message);
    } catch (error) {
      this.logger.warn("Runtime render failed.", error);
      return this.options.delivery.attempt();
    }
    return this.options.delivery.attempt();
  }
}
