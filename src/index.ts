import { ConfigStore } from "./config.js";
import { createApplication } from "./application.js";
import { runCliOnce } from "./cli.js";

if (process.argv.includes("--once")) {
  await runCliOnce({ dryRun: process.argv.includes("--dry-run") });
} else {
  const directory = process.env.VBMUX_DATA_DIR ?? "./data";
  const store = await ConfigStore.open(directory);
  const app = await createApplication(store, directory, process.argv.includes("--dry-run"));
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await app.stop();
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  await app.start().catch(async (error) => {
    console.error(error);
    await shutdown();
    process.exitCode = 1;
  });
}
