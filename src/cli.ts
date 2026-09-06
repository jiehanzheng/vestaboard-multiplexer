import { ConfigStore } from "./config.js";
import { createApplication } from "./application.js";

/** Runs one collection/render/write through the same engine as the service. */
export async function runCliOnce(options: { dataDirectory?: string; dryRun?: boolean } = {}): Promise<void> {
  const directory = options.dataDirectory ?? process.env.VBMUX_DATA_DIR ?? "./data";
  const store = await ConfigStore.open(directory);
  if (store.getPublic().error) throw new Error(`Fix configuration: ${store.getPublic().error}`);
  const app = await createApplication(store, directory, options.dryRun ?? process.argv.includes("--dry-run"));
  const shutdown = () => { void app.stop(); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    const attempt = await app.runOnce();
    if (attempt?.outcome === "failed") throw new Error("Vestaboard update failed.");
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await app.stop();
  }
}
