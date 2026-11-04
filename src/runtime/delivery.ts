import { AutomaticUpdateLimits } from "./updateLimits.js";
import type { UpdateLimit, UpdateLimitStatus } from "../contracts/updateLimits.js";
import type { VestaboardMessage } from "../vestaboard.js";
import type { DeliveryOutcome } from "../contracts/config.js";
import type { DeliveryVerification } from "../contracts/deliveryVerification.js";
export type { DeliveryOutcome } from "../contracts/config.js";

export interface DeliveryStatus {
  running: boolean;
  paused: boolean;
  pauseReason?: string;
  limits: UpdateLimitStatus[];
  pending: boolean;
  nextAttemptAt?: Date;
  lastAttemptAt?: Date;
  lastSuccessfulAt?: Date;
  lastOutcome?: DeliveryOutcome;
  hasFrame: boolean;
  verification?: DeliveryVerification;
}
export interface DeliveryAttempt { outcome: DeliveryOutcome; error?: unknown }

/** Captured once per submission: readback must use the endpoint that accepted it. */
export interface DeliveryTarget {
  send: (message: VestaboardMessage, usePauseAnimation?: boolean) => Promise<void>;
  readCurrent?: () => Promise<number[][]>;
  observationSource?: "local" | "cloud";
  minimumWriteIntervalMs?: number;
  observationDelayMs?: (message: VestaboardMessage, usePauseAnimation: boolean) => number;
}
export interface DeliveryControllerOptions {
  limits: UpdateLimit[];
  send?: DeliveryTarget["send"];
  captureTarget?: (usePauseAnimation: boolean) => DeliveryTarget;
  now?: () => Date;
  logger?: Pick<Console, "info" | "warn">;
}

const OBSERVATION_INTERVAL_MS = 60_000;
type WriteKind = "automatic" | "manual" | "correction" | "startup";
type Submission = {
  message: VestaboardMessage;
  key: string;
  userPaused?: boolean;
  usePauseAnimation: boolean;
  target: DeliveryTarget;
  phase: "posting" | "failed" | "observe" | "recheck" | "repair" | "done";
  verification: DeliveryVerification;
};

/** One operation owner for writes, observations, target changes and bounded recovery. */
export class DeliveryController {
  private readonly now: () => Date;
  private readonly logger: Pick<Console, "info" | "warn">;
  private readonly limits: AutomaticUpdateLimits;
  private frame?: VestaboardMessage;
  private frameUserPaused?: boolean;
  private submission?: Submission;
  private lastAcceptedFrame?: VestaboardMessage;
  // The budget belongs to the unresolved episode, not to changing content or UI renders.
  private correctionUsed = false;
  private generation = 0;
  private resetting = false;
  private operation?: Promise<DeliveryAttempt>;
  private lastAttemptAt?: Date;
  private lastSuccessfulAt?: Date;
  private lastOutcome?: DeliveryOutcome;
  private startupHoldUntil = 0;
  // Provider spacing survives settings changes, which must not create a write burst.
  private transportReadyAt = 0;
  private lastSentUserPaused?: boolean;
  private paused = false;
  private pauseReason?: string;
  private running = true;
  private readonly statusListeners = new Set<(status: DeliveryStatus) => void>();
  private schedulerPromise?: Promise<void>;
  private schedulerWake?: () => void;
  private schedulerTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: DeliveryControllerOptions) {
    if (!options.captureTarget && !options.send) throw new Error("A delivery target is required.");
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? console;
    this.limits = new AutomaticUpdateLimits(options.limits, this.now().getTime());
  }
  updateFrame(message: VestaboardMessage, userPaused?: boolean): void {
    this.frame = structuredClone(message);
    this.frameUserPaused = userPaused;
    this.requestNow();
  }
  setLimits(limits: UpdateLimit[]): void { this.limits.configure(limits, this.now().getTime()); this.notifyStatus(); this.requestNow(); }
  clearFrame(): void { this.frame = undefined; this.requestNow(); }
  pause(reason = "paused"): void {
    this.paused = true; this.pauseReason = reason; this.lastOutcome = "paused";
    this.notifyStatus(); this.requestNow();
  }
  resume(): void { this.paused = false; this.pauseReason = undefined; this.notifyStatus(); this.requestNow(); }
  onStatusChange(listener: (status: DeliveryStatus) => void): () => void { this.statusListeners.add(listener); return () => this.statusListeners.delete(listener); }
  currentFrame(): VestaboardMessage | undefined { return this.frame && structuredClone(this.frame); }
  /** Last HTTP-accepted frame; observation is reported separately. */
  lastSent(): VestaboardMessage | undefined { return this.lastAcceptedFrame && structuredClone(this.lastAcceptedFrame); }

  async resetTarget(): Promise<void> {
    const generation = ++this.generation;
    this.resetting = true;
    this.frame = undefined;
    this.submission = undefined;
    this.lastAcceptedFrame = undefined;
    this.correctionUsed = false;
    this.lastAttemptAt = this.lastSuccessfulAt = undefined;
    this.lastSentUserPaused = this.frameUserPaused = undefined;
    this.startupHoldUntil = 0;
    this.requestNow();
    await this.operation;
    if (generation !== this.generation) return;
    this.resetting = false;
    this.notifyStatus(); this.requestNow();
  }
  async stop(): Promise<void> {
    this.running = false;
    ++this.generation;
    this.lastOutcome = "stopped";
    this.notifyStatus(); this.requestNow();
    await this.operation;
    await this.schedulerPromise;
  }
  startScheduler(): Promise<void> {
    if (this.schedulerPromise) return this.schedulerPromise;
    if (!this.running) return Promise.resolve();
    this.schedulerPromise = this.schedulerLoop().finally(() => {
      this.schedulerPromise = undefined; this.schedulerWake = undefined;
      if (this.schedulerTimer !== undefined) clearTimeout(this.schedulerTimer);
    });
    return this.schedulerPromise;
  }
  requestNow(): void { this.schedulerWake?.(); }

  attempt(): Promise<DeliveryAttempt> { return this.operate(() => this.performAttempt(false)); }
  async attemptManual(): Promise<DeliveryAttempt> {
    const generation = this.generation;
    while (this.operation) await this.operation;
    if (generation !== this.generation) return { outcome: this.running ? "paused" : "stopped" };
    return this.operate(() => this.performAttempt(true));
  }
  deliverStartup(message: VestaboardMessage, holdAfterSuccessMs: number): Promise<DeliveryAttempt> {
    if (!Number.isFinite(holdAfterSuccessMs) || holdAfterSuccessMs < 0) throw new Error("Startup hold must be a non-negative number.");
    return this.operate(async () => {
      const held = this.hold();
      if (held) return this.finish(held);
      if (this.now().getTime() < this.transportReadyAt) return this.finish("limited");
      return this.submit(structuredClone(message), false, "startup", holdAfterSuccessMs);
    });
  }
  private operate(action: () => Promise<DeliveryAttempt>): Promise<DeliveryAttempt> {
    if (this.operation) return this.operation;
    // Install ownership before invoking user callbacks, including synchronous status listeners.
    const generation = this.generation;
    let resolve!: (attempt: DeliveryAttempt) => void;
    let reject!: (error: unknown) => void;
    const operation = new Promise<DeliveryAttempt>((done, fail) => { resolve = done; reject = fail; });
    this.operation = operation;
    try {
      const task = generation === this.generation ? action() : Promise.resolve({ outcome: this.running ? "paused" as const : "stopped" as const });
      void task.then(resolve, reject);
    } catch (error) { reject(error); }
    return operation.finally(() => {
      if (this.operation === operation) this.operation = undefined;
    });
  }
  private hold(): "stopped" | "paused" | undefined { return !this.running ? "stopped" : this.paused || this.resetting ? "paused" : undefined; }
  private needsWrite(): boolean {
    return !!this.frame && (messageKey(this.frame) !== this.submission?.key || ["posting", "failed", "repair"].includes(this.submission?.phase ?? ""));
  }
  private async performAttempt(manual: boolean): Promise<DeliveryAttempt> {
    const held = this.hold();
    if (held) return this.finish(held);
    if (!this.frame) return this.finish("empty");
    // Automatic changes cannot starve readback. A Save must still spend its
    // single immediate attempt on the explicitly requested intent.
    if (!manual && this.submission && this.submission.verification.nextCheckAt !== undefined && this.now().getTime() >= this.submission.verification.nextCheckAt) {
      return this.observe(this.submission);
    }
    if (this.needsWrite()) {
      const repairing = this.submission?.phase === "repair" && (!manual || messageKey(this.frame) === this.submission.key);
      const kind: WriteKind = repairing ? "correction" : manual ? "manual" : "automatic";
      // An explicit new intent keeps Save's admission exception; correction of the same frame does not.
      if (this.now().getTime() < this.writeReadyAt(kind === "manual")) return this.finish("limited");
      return this.submit(this.frame, this.frameUserPaused, kind);
    }
    if (this.frameUserPaused !== undefined && this.lastAcceptedFrame && messageKey(this.frame) === messageKey(this.lastAcceptedFrame)) {
      this.lastSentUserPaused = this.frameUserPaused;
    }
    return this.finish("unchanged");
  }
  private async submit(message: VestaboardMessage, userPaused: boolean | undefined, kind: WriteKind, startupHoldMs?: number): Promise<DeliveryAttempt> {
    const generation = this.generation;
    const previous = this.submission;
    const repairing = kind === "correction";
    // Repeating an unconfirmed pause/resume must retain its original transition choice.
    const usePauseAnimation = repairing && previous && userPaused === previous.userPaused ? previous.usePauseAnimation
      : userPaused !== undefined && (this.lastSentUserPaused === undefined ? userPaused : userPaused !== this.lastSentUserPaused);
    const target = this.options.captureTarget?.(usePauseAnimation) ?? { send: this.options.send! };
    const started = this.now().getTime();
    this.transportReadyAt = started + (target.minimumWriteIntervalMs ?? 0);
    if (kind !== "startup") { this.lastAttemptAt = new Date(started); this.limits.reserve(started); }
    if (repairing) this.correctionUsed = true;
    const submission: Submission = {
      message: structuredClone(message), key: messageKey(message), userPaused, usePauseAnimation, target, phase: "posting",
      verification: { state: "pending", source: target.observationSource, correctionUsed: this.correctionUsed }
    };
    this.submission = submission;
    try {
      await target.send(structuredClone(submission.message), usePauseAnimation);
      if (generation !== this.generation) return { outcome: this.running ? "paused" : "stopped" };
      const at = this.now().getTime();
      const nextCheckAt = target.readCurrent ? Math.max(at + OBSERVATION_INTERVAL_MS, started + (target.observationDelayMs?.(message, usePauseAnimation) ?? 0)) : undefined;
      submission.phase = nextCheckAt === undefined ? "done" : "observe";
      submission.verification = { state: nextCheckAt === undefined ? "unverified" : "pending", source: target.observationSource, nextCheckAt, correctionUsed: this.correctionUsed };
      this.lastAcceptedFrame = structuredClone(submission.message);
      this.lastSuccessfulAt = new Date(at);
      if (startupHoldMs !== undefined) { this.lastAttemptAt = new Date(at); this.startupHoldUntil = at + startupHoldMs; }
      if (userPaused !== undefined) this.lastSentUserPaused = userPaused;
      this.logger.info(startupHoldMs !== undefined ? "Transport accepted startup frame." : repairing ? "Transport accepted corrective frame." : kind === "manual" ? "Transport accepted frame after settings save." : "Transport accepted latest Vestaboard frame.");
      return this.finish("sent");
    } catch (error) {
      if (generation !== this.generation) return { outcome: this.running ? "paused" : "stopped" };
      this.endVerification(submission, "unverified", repairing
        ? "The corrective write failed; automatic correction has stopped." : "The API did not accept the frame.");
      if (!repairing) submission.phase = "failed";
      return this.finish("failed", error);
    }
  }
  private async observe(submission: Submission): Promise<DeliveryAttempt> {
    const generation = this.generation;
    try {
      const matrix = await submission.target.readCurrent!();
      if (!this.observationIsCurrent(submission, generation)) return { outcome: this.running ? "unchanged" : "stopped" };
      const at = this.now().getTime();
      submission.verification.checkedAt = at;
      if (JSON.stringify(matrix) === JSON.stringify(submission.message.characters)) {
        this.correctionUsed = false;
        submission.verification.correctionUsed = false;
        this.endVerification(submission, "matched");
      } else if (submission.phase === "observe") {
        // A second scheduled observation avoids treating one in-transition sample as durable drift.
        this.logger.info("Readback differs; a second observation is scheduled.");
        submission.phase = "recheck";
        submission.verification.nextCheckAt = at + OBSERVATION_INTERVAL_MS;
      } else if (!this.correctionUsed) {
        this.logger.warn("Readback still differs; one correction is pending normal admission.");
        submission.phase = "repair";
        submission.verification.state = "mismatch";
        submission.verification.nextCheckAt = undefined;
      } else this.endVerification(submission, "mismatch", "Readback still differs after correction; automatic correction has stopped.");
      return this.finish("unchanged");
    } catch {
      if (!this.observationIsCurrent(submission, generation)) return { outcome: this.running ? "unchanged" : "stopped" };
      this.endVerification(submission, "unverified", "Readback failed; no automatic corrective write will be made.");
      return this.finish("unchanged");
    }
  }
  private observationIsCurrent(submission: Submission, generation: number): boolean {
    return generation === this.generation && this.running && !this.paused && this.submission === submission && !!this.frame;
  }
  private endVerification(submission: Submission, state: DeliveryVerification["state"], error?: string): void {
    submission.phase = "done";
    submission.verification.state = state;
    submission.verification.nextCheckAt = undefined;
    submission.verification.error = error;
    if (error) this.logger.warn(error);
    else this.logger.info("Vestaboard API readback matches the accepted frame.");
  }
  private writeReadyAt(manual = false): number {
    return Math.max(this.startupHoldUntil, this.transportReadyAt, manual ? 0 : this.limits.nextEligibleAt(this.now().getTime()) ?? 0);
  }
  private nextActionAt(): number | undefined {
    if (this.hold() || !this.frame) return undefined;
    if (this.needsWrite()) return this.writeReadyAt();
    return this.submission?.verification.nextCheckAt;
  }
  status(): DeliveryStatus {
    const now = this.now().getTime();
    const next = this.writeReadyAt();
    return {
      running: this.running, paused: this.paused, pauseReason: this.pauseReason,
      limits: this.limits.status(now), pending: this.needsWrite(),
      nextAttemptAt: next !== undefined && next > now ? new Date(next) : undefined,
      lastAttemptAt: this.lastAttemptAt, lastSuccessfulAt: this.lastSuccessfulAt,
      lastOutcome: this.lastOutcome, hasFrame: !!this.frame,
      verification: this.submission && structuredClone(this.submission.verification)
    };
  }
  private finish(outcome: DeliveryOutcome, error?: unknown): DeliveryAttempt {
    this.lastOutcome = outcome; this.notifyStatus();
    return error === undefined ? { outcome } : { outcome, error };
  }
  private notifyStatus(): void { for (const listener of this.statusListeners) listener(this.status()); }
  private async schedulerLoop(): Promise<void> {
    while (this.running) {
      await this.attempt();
      if (!this.running) break;
      const next = this.nextActionAt();
      await this.waitForScheduler(next === undefined ? undefined : Math.max(0, next - this.now().getTime()));
    }
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
      if (delayMs !== undefined) this.schedulerTimer = setTimeout(done, Math.min(delayMs, 2_147_483_647));
    });
  }
}
function messageKey(message: VestaboardMessage): string { return JSON.stringify(message.characters ?? message.text); }
