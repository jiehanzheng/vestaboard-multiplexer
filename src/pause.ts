import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export class PauseStore {
  private manualPause = false;
  private haPause = false;
  private queue: Promise<void> = Promise.resolve();

  private constructor(private readonly directory: string) {}

  static async open(directory: string): Promise<PauseStore> {
    const store = new PauseStore(directory);
    try {
      const value = JSON.parse(await readFile(join(directory, "pause.json"), "utf8"));
      if (typeof value.manualPause !== "boolean" || typeof value.haPause !== "boolean") {
        throw new Error("Invalid pause state");
      }
      store.manualPause = value.manualPause;
      store.haPause = value.haPause;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // An unreadable pause file must not silently allow a board write.
        store.manualPause = true;
      }
    }
    return store;
  }

  status(): { manualPause: boolean; haPause: boolean; paused: boolean } {
    return { manualPause: this.manualPause, haPause: this.haPause, paused: this.manualPause || this.haPause };
  }

  setManual(value: boolean): Promise<void> { return this.save("manualPause", value); }
  setHA(value: boolean): Promise<void> { return this.save("haPause", value); }

  private save(key: "manualPause" | "haPause", value: boolean): Promise<void> {
    const task = this.queue.then(async () => {
      const next = { manualPause: this.manualPause, haPause: this.haPause, [key]: value };
      await mkdir(this.directory, { recursive: true });
      const file = join(this.directory, "pause.json");
      await writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      this.manualPause = next.manualPause;
      this.haPause = next.haPause;
    });
    this.queue = task.catch(() => {});
    return task;
  }
}
