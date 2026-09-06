export interface CollectionStatus {
  running: boolean;
  intervalMs: number;
  lastStartedAt?: Date;
  lastCompletedAt?: Date;
  lastFailure?: unknown;
}

export interface CollectionControllerOptions {
  intervalMs: number;
  collect: () => Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  onCollected?: () => Promise<void> | void;
  logger?: Pick<Console, "warn">;
}

/** Runs quota collection independently of presentation and delivery cadence. */
export class CollectionController {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly usesDefaultSleep: boolean;
  private readonly logger: Pick<Console, "warn">;
  private running = false;
  private stopRequested = false;
  private wake: (() => void) | undefined;
  private loopPromise: Promise<void> | undefined;
  private lastStartedAt: Date | undefined;
  private lastCompletedAt: Date | undefined;
  private lastFailure: unknown;

  constructor(private readonly options: CollectionControllerOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error("Collection interval must be a positive number.");
    }
    this.now = options.now ?? (() => new Date());
    this.usesDefaultSleep = options.sleep === undefined;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger ?? console;
  }

  start(): Promise<void> {
    if (this.loopPromise) return this.loopPromise;
    this.running = true;
    this.stopRequested = false;
    this.loopPromise = this.loop().finally(() => {
      this.running = false;
      this.loopPromise = undefined;
    });
    return this.loopPromise;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.running = false;
    this.wake?.();
    await this.loopPromise;
  }

  requestNow(): void {
    this.wake?.();
  }

  setInterval(intervalMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error("Collection interval must be a positive number.");
    }
    this.options.intervalMs = intervalMs;
    this.requestNow();
  }

  status(): CollectionStatus {
    return {
      running: this.running,
      intervalMs: this.options.intervalMs,
      lastStartedAt: this.lastStartedAt ? new Date(this.lastStartedAt) : undefined,
      lastCompletedAt: this.lastCompletedAt ? new Date(this.lastCompletedAt) : undefined,
      lastFailure: this.lastFailure,
    };
  }

  private async loop(): Promise<void> {
    while (!this.stopRequested) {
      this.lastStartedAt = new Date(this.now());
      try {
        await this.options.collect();
        this.lastFailure = undefined;
        this.lastCompletedAt = new Date(this.now());
      } catch (error) {
        this.lastFailure = error;
        this.logger.warn("Quota collection failed.", error);
      }

      try {
        await this.options.onCollected?.();
      } catch (error) {
        this.logger.warn("Collection frame refresh failed.", error);
      }

      if (!this.stopRequested) {
        await this.sleepUntilNextCollection();
      }
    }
  }

  private async sleepUntilNextCollection(): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        if (this.wake === done) this.wake = undefined;
        resolve();
      };
      this.wake = done;
      if (this.usesDefaultSleep) {
        timer = setTimeout(done, this.options.intervalMs);
      } else {
        void this.sleep(this.options.intervalMs).then(done, done);
      }
    });
  }
}
