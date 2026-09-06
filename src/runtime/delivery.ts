import type { VestaboardMessage } from "../orchestrator.js";

export type DeliveryOutcome = "sent" | "unchanged" | "failed" | "paused" | "limited" | "empty" | "stopped" | "in-flight";

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
  private nextAttemptAt: Date | undefined;
  private lastAttemptAt: Date | undefined;
  private lastSuccessfulAt: Date | undefined;
  private lastSentFrame: VestaboardMessage | undefined;
  private lastOutcome: DeliveryOutcome | undefined;
  private paused = false;
  private pauseReason: string | undefined;
  private running = true;
  private sentMessageKey: string | undefined;
  private inFlight: Promise<DeliveryAttempt> | undefined;
  private readonly listeners = new Set<(message: VestaboardMessage) => void>();
  private readonly statusListeners = new Set<(status: DeliveryStatus) => void>();

  constructor(private readonly options: DeliveryControllerOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error("Delivery interval must be a positive number.");
    }
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? console;
  }

  updateFrame(message: VestaboardMessage): void {
    this.frame = message;
    this.listeners.forEach((listener) => listener(message));
  }

  setInterval(intervalMs: number): void {
    validateInterval(intervalMs, "Delivery");
    this.options.intervalMs = intervalMs;
    this.notifyStatus();
  }

  clearFrame(): void {
    this.frame = undefined;
  }

  pause(reason = "paused"): void {
    this.paused = true;
    this.pauseReason = reason;
    this.lastOutcome = "paused";
    this.notifyStatus();
  }

  resume(): void {
    this.paused = false;
    this.pauseReason = undefined;
    this.notifyStatus();
  }

  onChange(listener: (message: VestaboardMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatusChange(listener: (status: DeliveryStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  currentFrame(): VestaboardMessage | undefined {
    return this.frame;
  }

  lastSent(): VestaboardMessage | undefined {
    return this.lastSentFrame;
  }

  clearLastSent(): void {
    this.sentMessageKey = undefined;
    this.lastSentFrame = undefined;
    this.lastSuccessfulAt = undefined;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.lastOutcome = "stopped";
    this.notifyStatus();
    await this.inFlight;
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
    if (this.nextAttemptAt && now.getTime() < this.nextAttemptAt.getTime()) {
      return this.finish("limited");
    }

    this.nextAttemptAt = undefined;

    if (!this.frame) return this.finish("empty");

    const message = this.frame;
    if (this.sentMessageKey === messageKey(message)) {
      this.logger.info("Skipped unchanged Vestaboard message.");
      return this.finish("unchanged");
    }

    this.lastAttemptAt = new Date(now);
    this.nextAttemptAt = new Date(now.getTime() + this.options.intervalMs);

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
      this.nextAttemptAt = new Date(now.getTime() + holdAfterSuccessMs);
      this.logger.info("Sent Vestaboard startup message.");
      return this.finish("sent");
    } catch (error) {
      this.logger.warn("Vestaboard startup message send failed.", error);
      return this.finish("failed", error);
    }
  }

  status(): DeliveryStatus {
    return {
      running: this.running,
      paused: this.paused,
      pauseReason: this.pauseReason,
      intervalMs: this.options.intervalMs,
      nextAttemptAt: this.nextAttemptAt ? new Date(this.nextAttemptAt) : undefined,
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
}

function messageKey(message: VestaboardMessage): string {
  return JSON.stringify(message.characters ?? message.text);
}

function validateInterval(intervalMs: number, label: string): void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`${label} interval must be a positive number.`);
  }
}
