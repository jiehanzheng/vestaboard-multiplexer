import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface PauseStoreStatus {
  manualPause: boolean;
  paused: boolean;
  pauseReason?: string;
  persistenceError?: string;
}

const PERSISTENCE_ERROR = "Could not persist pause state.";
const READ_ERROR = "Saved pause state is invalid; updates remain paused until it is repaired.";

/** Durable manual pause state; each queued write captures its own target. */
export class PauseStore {
  private state = { manualPause: false };
  private requested = { manualPause: false };
  private persistenceError: string | undefined;
  private queue: Promise<void> = Promise.resolve();

  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<PauseStore> {
    const store = new PauseStore(directory);
    try {
      const value = JSON.parse(await readFile(join(directory, "pause.json"), "utf8")) as Record<string, unknown>;
      if (typeof value.manualPause !== "boolean") throw new Error("Invalid pause state");
      store.state = { manualPause: value.manualPause };
      store.requested = { ...store.state };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        store.state.manualPause = true;
        store.requested = { ...store.state };
        store.persistenceError = READ_ERROR;
      }
    }
    return store;
  }

  status(): PauseStoreStatus {
    const manualPause = this.requested.manualPause || this.state.manualPause;
    const paused = manualPause || this.persistenceError !== undefined;
    return {
      manualPause,
      paused,
      ...(this.persistenceError ? { persistenceError: this.persistenceError } : {}),
      ...(paused ? { pauseReason: this.persistenceError ?? "Paused manually" } : {})
    };
  }

  setManual(value: boolean): Promise<void> {
    const target = { manualPause: value };
    this.requested = target;
    const task = this.queue.then(async () => {
      if (!sameState(target, this.state) || this.persistenceError !== undefined) {
        await this.persist(target);
        this.state = target;
        this.persistenceError = undefined;
      }
    });
    this.queue = task.catch(() => {});
    return task.catch((error) => {
      this.persistenceError = PERSISTENCE_ERROR;
      throw error;
    });
  }

  flush(): Promise<void> { return this.queue; }

  private async persist(next: { manualPause: boolean }): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const file = join(this.directory, "pause.json");
    await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  }
}

function sameState(left: { manualPause: boolean }, right: { manualPause: boolean }): boolean {
  return left.manualPause === right.manualPause;
}
