import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { HAConfig } from "./contracts/homeAssistant.js";
import type { HomeAssistantServiceLike, HomeAssistantSnapshot } from "./homeAssistantService.js";
import { haPauseBinding, readHAPause } from "./haPause.js";


type PauseState = { manualPause: boolean; haPause: boolean; haBinding?: string };

export interface PauseStoreStatus {
  manualPause: boolean;
  haPause: boolean;
  paused: boolean;
  persistenceError?: string;
}

const PERSISTENCE_ERROR = "Could not persist pause state.";
const READ_ERROR = "Saved pause state is invalid; updates remain paused until it is repaired.";

/** Durable manual and platform pause state. A failed resume remains paused. */
export class PauseStore {
  private state: PauseState = { manualPause: false, haPause: false };
  private requested: PauseState = { manualPause: false, haPause: false };
  private persistenceError: string | undefined;
  private queue: Promise<void> = Promise.resolve();

  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<PauseStore> {
    const store = new PauseStore(directory);
    try {
      const value = JSON.parse(await readFile(join(directory, "pause.json"), "utf8")) as Record<string, unknown>;
      if (typeof value.manualPause !== "boolean" || typeof value.haPause !== "boolean" ||
          (value.haBinding !== undefined && typeof value.haBinding !== "string")) {
        throw new Error("Invalid pause state");
      }
      store.state = { manualPause: value.manualPause, haPause: value.haPause, haBinding: value.haBinding as string | undefined };
      store.requested = { ...store.state };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // An unreadable pause file must not silently allow a board write.
        store.state.manualPause = true;
        store.requested = { ...store.state };
        store.persistenceError = READ_ERROR;
      }
    }
    return store;
  }

  status(): PauseStoreStatus {
    const manualPause = this.requested.manualPause || this.state.manualPause;
    const haPause = this.requested.haPause || this.state.haPause;
    return {
      manualPause,
      haPause,
      paused: manualPause || haPause || this.persistenceError !== undefined,
      ...(this.persistenceError ? { persistenceError: this.persistenceError } : {})
    };
  }

  setManual(value: boolean): Promise<void> {
    this.requested = { ...this.requested, manualPause: value };
    return this.enqueue((state) => ({ ...state, manualPause: value }));
  }

  bindHA(key?: string): Promise<void> {
    const sameBinding = this.requested.haBinding === key;
    if (key === undefined) {
      this.requested = { ...this.requested, haBinding: undefined, haPause: false };
    } else if (!sameBinding) {
      // A new binding is fail-closed until its state is persisted and observed.
      this.requested = { ...this.requested, haBinding: key, haPause: true };
    }
    return this.enqueue((state) => key === undefined
        ? { ...state, haBinding: undefined, haPause: false }
        : sameBinding ? state : { ...state, haBinding: key, haPause: true }
    );
  }

  setHA(value: boolean, key?: string): Promise<void> {
    if (this.requested.haBinding !== key) return Promise.resolve();
    this.requested = { ...this.requested, haPause: value };
    return this.enqueue((state) => state.haBinding === key ? { ...state, haPause: value } : state);
  }

  flush(): Promise<void> { return this.queue; }

  private enqueue(update: (state: PauseState) => PauseState): Promise<void> {
    const task = this.queue.then(async () => {
      const next = update(this.state);
      if (!sameState(next, this.state) || this.persistenceError !== undefined) {
        await this.persist(next);
        this.state = next;
        this.persistenceError = undefined;
      }
    });
    this.queue = task.catch(() => {});
    return task.catch((error) => {
      this.persistenceError = PERSISTENCE_ERROR;
      throw error;
    });
  }

  private async persist(next: PauseState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const file = join(this.directory, "pause.json");
    await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
}

export interface PauseControllerStatus extends PauseStoreStatus {
  pauseReason?: string;
}

/** Platform pause consumer. It owns the HA binding and leaves raw HA data to the shared service. */
export class PauseController {
  private readonly changed?: () => void;
  private readonly service: HomeAssistantServiceLike;
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly store: PauseStore;
  private unsubscribe: (() => void) | undefined;
  private config: HAConfig = { url: "", pause: null };
  private binding: string | undefined;
  private generation = 0;
  private stopped = false;
  private controllerError: string | undefined;

  private constructor(store: PauseStore, service: HomeAssistantServiceLike, changed?: () => void) {
    this.store = store;
    this.service = service;
    this.changed = changed;
  }

  static async open(directory: string, service: HomeAssistantServiceLike, changed?: () => void): Promise<PauseController> {
    return new PauseController(await PauseStore.open(directory), service, changed);
  }

  async configure(config: HAConfig): Promise<void> {
    this.stopped = false;
    this.config = config;
    const generation = ++this.generation;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const nextBinding = haPauseBinding(config);
    this.binding = nextBinding;
    const persistBinding = this.store.bindHA(nextBinding);
    this.notifyChanged();
    try {
      await persistBinding;
      this.controllerError = undefined;
    } catch {
      this.controllerError = PERSISTENCE_ERROR;
    }
    if (this.stopped || generation !== this.generation) return;
    this.unsubscribe = this.service.subscribe((snapshot) => {
      if (snapshot.source !== this.config.url) return;
      const task = this.handleSnapshot(snapshot, generation);
      this.track(task);
    });
    await this.handleSnapshot(this.service.snapshot(), generation);
    this.notifyChanged();
  }

  async manual(value: boolean): Promise<void> {
    const persistManual = this.store.setManual(value);
    this.notifyChanged();
    try {
      await persistManual;
      this.controllerError = undefined;
    } catch {
      this.controllerError = PERSISTENCE_ERROR;
    }
    this.notifyChanged();
  }

  setManual(value: boolean): Promise<void> { return this.manual(value); }

  status(): PauseControllerStatus {
    const storeStatus = this.store.status();
    const persistenceError = this.controllerError ?? storeStatus.persistenceError;
    const pauseReason = persistenceError
      ?? (storeStatus.manualPause ? "Paused manually" : storeStatus.haPause ? "Paused by Home Assistant" : undefined);
    return {
      ...storeStatus,
      ...(persistenceError ? { persistenceError } : {}),
      ...(pauseReason ? { pauseReason } : {})
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation += 1;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await Promise.allSettled([...this.tasks]);
    await this.store.flush();
  }

  flush(): Promise<void> {
    return Promise.allSettled([...this.tasks]).then(() => this.store.flush()).then(() => undefined);
  }

  private async handleSnapshot(snapshot: HomeAssistantSnapshot, generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation || snapshot.source !== this.config.url || !this.binding || !snapshot.connected) return;
    const value = readHAPause(this.config, snapshot.entities);
    if (value === undefined) return;
    const persistHA = this.store.setHA(value, this.binding);
    this.notifyChanged();
    try {
      await persistHA;
      this.controllerError = undefined;
    } catch {
      this.controllerError = PERSISTENCE_ERROR;
    }
    if (!this.stopped && generation === this.generation) this.notifyChanged();
  }

  private track(task: Promise<void>): void {
    const tracked = task.finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
  }

  private notifyChanged(): void {
    try { this.changed?.(); } catch { /* observers cannot break pause ownership */ }
  }
}

function sameState(left: PauseState, right: PauseState): boolean {
  return left.manualPause === right.manualPause && left.haPause === right.haPause && left.haBinding === right.haBinding;
}
