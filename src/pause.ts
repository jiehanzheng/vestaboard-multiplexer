import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

type PauseState = { manualPause: boolean; haPause: boolean; haBinding?: string };

export class PauseStore {
  private state: PauseState = { manualPause: false, haPause: false };
  private queue: Promise<void> = Promise.resolve();

  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<PauseStore> {
    const store = new PauseStore(directory);
    try {
      const value = JSON.parse(await readFile(join(directory, "pause.json"), "utf8"));
      if (typeof value.manualPause !== "boolean" || typeof value.haPause !== "boolean" ||
          (value.haBinding !== undefined && typeof value.haBinding !== "string")) {
        throw new Error("Invalid pause state");
      }
      store.state = { manualPause: value.manualPause, haPause: value.haPause, haBinding: value.haBinding };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // An unreadable pause file must not silently allow a board write.
        store.state.manualPause = true;
      }
    }
    return store;
  }

  status(): { manualPause: boolean; haPause: boolean; paused: boolean } {
    const { manualPause, haPause } = this.state;
    return { manualPause, haPause, paused: manualPause || haPause };
  }

  setManual(value: boolean): Promise<void> {
    return this.save((state) => ({ ...state, manualPause: value }));
  }

  bindHA(key?: string): Promise<void> {
    return this.save((state) => state.haBinding === key && (key !== undefined || !state.haPause) ? state : {
      ...state, haBinding: key, haPause: key !== undefined
    });
  }

  setHA(value: boolean, key?: string): Promise<void> {
    // Remembered values belong to one binding; late events from a replaced connection cannot resume it.
    return this.save((state) => state.haBinding !== key ? state : { ...state, haPause: value });
  }

  flush(): Promise<void> { return this.queue; }

  private save(update: (state: PauseState) => PauseState): Promise<void> {
    const task = this.queue.then(async () => {
      const next = update(this.state);
      if (JSON.stringify(next) === JSON.stringify(this.state)) return;
      await mkdir(this.directory, { recursive: true });
      const file = join(this.directory, "pause.json");
      await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      this.state = next;
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
