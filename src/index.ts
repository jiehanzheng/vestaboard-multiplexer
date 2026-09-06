import { ConfigStore } from "./config.js";
import { createApplication } from "./application.js";
import { startWebServer } from "./webServer.js";

if (process.argv.includes("--once")) {
  await import("./cli.js");
} else {
  const directory = process.env.VBMUX_DATA_DIR ?? "./data";
  const store = await ConfigStore.open(directory);
  const app = await createApplication(store, directory, process.argv.includes("--dry-run"));
  const port = Number(process.env.VBMUX_PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("VBMUX_PORT must be a valid port.");
  const server = await startWebServer(app.actions, { port, host: process.env.VBMUX_HOST ?? "0.0.0.0" });
  app.onChange(server.broadcast);
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    process.off("SIGHUP", refresh);
    process.off("SIGUSR2", demo);
    await app.stop();
    await server.close();
  };
  const refresh = () => { void app.refresh(); };
  const demo = () => { app.demo(); };
  process.on("SIGHUP", refresh);
  process.on("SIGUSR2", demo);
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  console.info(`vbmux UI listening on port ${port}`);
  await app.start().catch(async (error) => { console.error(error); await shutdown(); process.exitCode = 1; });
}
