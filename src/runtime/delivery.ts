import type { VestaboardMessage } from "../vestaboard.js";

export type DeliveryOutcome = "sent" | "unchanged" | "failed" | "paused" | "limited" | "empty" | "stopped";

export interface DeliveryStatus {
  running: boolean;
  paused: boolean;
  pauseReason?: string;
  intervalMs: number;
  nextAttemptAt?: Date;
  lastAttemptAt?: Date;
  lastSuccessfulAt?: Date;
  lastOutcome?: DeliveryOutcome;
  hasFrame: boolean;
}

export interface DeliveryAttempt {
  outcome: DeliveryOutcome;
  error?: unknown;
}

export interface DeliveryControllerOptions {
  intervalMs: number;
  send: (message: VestaboardMessage) => Promise<void>;
  now?: () => Date;
  logger?: Pick<Console, "info" | "warn">;
}

/**
 * Owns the write cadence and the last successful message. Collection can keep
 * replacing the frame while this controller is paused or rate limited.
 */
export class DeliveryController {
  private readonly now: () => Date;
  private readonly logger: Pick<Console, "info" | "warn">;
  private frame: VestaboardMessage | undefined;
  private lastAttemptAt: Date | undefined;
  private lastNormalAttemptAt: Date | undefined;
  private lastSuccessfulAt: Date | undefined;
  private startupHoldUntil: Date | undefined;
  private lastSentFrame: VestaboardMessage | undefined;
  private lastOutcome: DeliveryOutcome | undefined;
  private paused = false;
  private pauseReason: string | undefined;
  private running = true;
  private sentMessageKey: string | undefined;
  private inFlight: Promise<DeliveryAttempt> | undefined;
  private readonly statusListeners = new Set<(status: DeliveryStatus) => void>();
  private schedulerPromise: Promise<void> | undefined;
  private schedulerWake: (() => void) | undefined;
  private schedulerTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: DeliveryControllerOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error("Delivery interval must be a positive number.");
    }
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? console;
  }

  updateFrame(message: VestaboardMessage): void {
    this.frame = structuredClone(message);
    this.requestNow();
  }

  setInterval(intervalMs: number): void {
    validateInterval(intervalMs, "Delivery");
    this.options.intervalMs = intervalMs;
    this.notifyStatus();
    this.requestNow();
  }

  clearFrame(): void {
    this.frame = undefined;
  }

  pause(reason = "paused"): void {
    if (this.paused && this.pauseReason === reason) return;
    this.paused = true;
    this.pauseReason = reason;
    this.lastOutcome = "paused";
    this.notifyStatus();
    this.requestNow();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.pauseReason = undefined;
    this.notifyStatus();
    this.requestNow();
  }

  onStatusChange(listener: (status: DeliveryStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  currentFrame(): VestaboardMessage | undefined {
    return this.frame ? structuredClone(this.frame) : undefined;
  }

  lastSent(): VestaboardMessage | undefined {
    return this.lastSentFrame ? structuredClone(this.lastSentFrame) : undefined;
  }

  /** Serializes a board target transition behind any write already in flight. */
  async resetTarget(): Promise<void> {
    await this.inFlight;
    this.sentMessageKey = undefined;
    this.lastSentFrame = undefined;
    this.lastSuccessfulAt = undefined;
    this.requestNow();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.lastOutcome = "stopped";
    this.notifyStatus();
    this.schedulerWake?.();
    await this.inFlight;
    await this.schedulerPromise;
  }

  /** Runs the write scheduler over the latest published frame. */
  startScheduler(): Promise<void> {
    if (this.schedulerPromise) return this.schedulerPromise;
    if (!this.running) return Promise.resolve();
    this.schedulerPromise = this.schedulerLoop().finally(() => {
      this.schedulerPromise = undefined;
      this.schedulerWake = undefined;
      if (this.schedulerTimer !== undefined) clearTimeout(this.schedulerTimer);
      this.schedulerTimer = undefined;
    });
    return this.schedulerPromise;
  }

  requestNow(): void {
    this.schedulerWake?.();
  }

  /**
   * Sends the latest frame when the limiter allows it. The attempt slot is
   * reserved before the write begins, so failures consume the full interval.
   */
  async attempt(): Promise<DeliveryAttempt> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.performAttempt();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async performAttempt(): Promise<DeliveryAttempt> {
    if (!this.running) return this.finish("stopped");
    if (this.paused) return this.finish("paused");

    const now = this.now();
    const eligibleAt = this.nextEligibleAt();
    if (eligibleAt && now.getTime() < eligibleAt.getTime()) {
      return this.finish("limited");
    }

    if (!this.frame) return this.finish("empty");

    const message = this.frame;
    if (this.sentMessageKey === messageKey(message)) {
      return this.finish("unchanged");
    }

    this.lastAttemptAt = new Date(now);
    this.lastNormalAttemptAt = new Date(now);

    try {
      await this.options.send(message);
      this.sentMessageKey = messageKey(message);
      this.lastSentFrame = message;
      this.lastSuccessfulAt = new Date(this.now());
      this.logger.info("Sent latest Vestaboard frame.");
      return this.finish("sent");
    } catch (error) {
      this.logger.warn("Vestaboard frame send failed.", error);
      return this.finish("failed", error);
    }
  }

  /** Bypasses the normal cadence for startup, applying a hold after success. */
  async deliverStartup(message: VestaboardMessage, holdAfterSuccessMs: number): Promise<DeliveryAttempt> {
    if (!Number.isFinite(holdAfterSuccessMs) || holdAfterSuccessMs < 0) {
      throw new Error("Startup hold must be a non-negative number.");
    }
    if (!this.running) return this.finish("stopped");
    if (this.paused) return this.finish("paused");
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.performStartup(message, holdAfterSuccessMs);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async performStartup(message: VestaboardMessage, holdAfterSuccessMs: number): Promise<DeliveryAttempt> {

    try {
      await this.options.send(message);
      const now = this.now();
      this.sentMessageKey = messageKey(message);
      this.lastSentFrame = message;
      this.lastAttemptAt = new Date(now);
      this.lastSuccessfulAt = new Date(now);
      this.startupHoldUntil = new Date(now.getTime() + holdAfterSuccessMs);
      this.logger.info("Sent Vestaboard startup message.");
      return this.finish("sent");
    } catch (error) {
      this.logger.warn("Vestaboard startup message send failed.", error);
      return this.finish("failed", error);
    }
  }

  status(): DeliveryStatus {
    const nextEligibleAt = this.nextEligibleAt();
    const now = this.now().getTime();
    return {
      running: this.running,
      paused: this.paused,
      pauseReason: this.pauseReason,
      intervalMs: this.options.intervalMs,
      nextAttemptAt: nextEligibleAt && nextEligibleAt.getTime() > now ? nextEligibleAt : undefined,
      lastAttemptAt: this.lastAttemptAt ? new Date(this.lastAttemptAt) : undefined,
      lastSuccessfulAt: this.lastSuccessfulAt ? new Date(this.lastSuccessfulAt) : undefined,
      lastOutcome: this.lastOutcome,
      hasFrame: this.frame !== undefined
    };
  }

  private finish(outcome: DeliveryOutcome, error?: unknown): DeliveryAttempt {
    this.lastOutcome = outcome;
    this.notifyStatus();
    return error === undefined ? { outcome } : { outcome, error };
  }

  private notifyStatus(): void {
    if (this.statusListeners.size === 0) return;
    const status = this.status();
    this.statusListeners.forEach((listener) => listener(status));
  }

  private async schedulerLoop(): Promise<void> {
    while (this.running) {
      const attempt = await this.attempt();
      if (!this.running) break;
      const next = this.nextEligibleAt()?.getTime();
      const now = this.now().getTime();
      // Paused, empty and unchanged frames wait for a real change. In
      // particular an expired deadline while paused must not create a busy loop.
      const pending = this.frame && messageKey(this.frame) !== this.sentMessageKey;
      const delay = !this.paused && pending ? Math.max(0, (next ?? now) - now) : undefined;
      await this.waitForScheduler(delay);
      if (attempt.outcome === "stopped") break;
    }
  }

  private nextEligibleAt(): Date | undefined {
    const normal = this.lastNormalAttemptAt
      ? this.lastNormalAttemptAt.getTime() + this.options.intervalMs
      : undefined;
    const startup = this.startupHoldUntil?.getTime();
    const candidates = [normal, startup].filter((value): value is number => value !== undefined);
    if (candidates.length === 0) return undefined;
    return new Date(Math.max(...candidates));
  }

  private async waitForScheduler(delayMs: number | undefined): Promise<void> {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        if (this.schedulerTimer !== undefined) clearTimeout(this.schedulerTimer);
        if (this.schedulerWake === done) this.schedulerWake = undefined;
        resolve();
      };
      this.schedulerWake = done;
      if (delayMs !== undefined) this.schedulerTimer = setTimeout(done, delayMs);
    });
  }
}

function messageKey(message: VestaboardMessage): string {
  return JSON.stringify(message.characters ?? message.text);
}

function validateInterval(intervalMs: number, label: string): void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`${label} interval must be a positive number.`);
  }
}
