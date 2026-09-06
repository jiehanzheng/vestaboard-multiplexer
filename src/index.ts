import { createCodexQuotaPlugin } from "./plugins/codexQuota/index.js";
import { CollectionController } from "./runtime/collection.js";
import { DeliveryController } from "./runtime/delivery.js";
import { RuntimeController } from "./runtime/runtime.js";
import { RuntimeSignalController } from "./runtimeSignals.js";
import { formatStartupMessage } from "./startupMessage.js";
import { boardPreferenceFromEnv, createVestaboardBoardResolver } from "./vestaboardBoard.js";
import { createVestaboardClient, localMessageTransitionOptionsFromEnv } from "./vestaboard.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const once = args.includes("--once");
const intervalMinutes = positiveEnvNumber(process.env.ORCHESTRATOR_INTERVAL_MINUTES, 5);
const quotaPollIntervalSeconds = positiveEnvNumber(process.env.CODEX_QUOTA_POLL_INTERVAL_SECONDS, 60);
const startupHoldMs = 30_000;
const vestaboardTransport = process.env.VESTABOARD_LOCAL_API_KEY ? "local" : "cloud";
const demoPauseMinutes = Number(process.env.CODEX_QUOTA_DEMO_PAUSE_MINUTES ?? "5");
const runtimeSignals = new RuntimeSignalController();
const localMessageTransition = localMessageTransitionOptionsFromEnv(process.env, console);

const vestaboard = createVestaboardClient({
  dryRun,
  token: process.env.VESTABOARD_TOKEN,
  localApiKey: process.env.VESTABOARD_LOCAL_API_KEY,
  cloudUrl: process.env.VESTABOARD_CLOUD_URL,
  localUrl: process.env.VESTABOARD_LOCAL_URL,
  localMessageTransition: localMessageTransition.options
});
const boardResolver = createVestaboardBoardResolver({
  preference: boardPreferenceFromEnv(process.env.VESTABOARD_BOARD),
  detectBoard: vestaboard.detectBoard,
  logger: console
});

const codexQuotaPlugin = createCodexQuotaPlugin({
  fixture: process.env.CODEX_QUOTA_SOURCE === "fixture",
  priority: process.env.CODEX_QUOTA_PRIORITY ?? "normal",
  errorPriority: process.env.CODEX_QUOTA_ERROR_PRIORITY ?? "low",
  timeZone: process.env.CODEX_QUOTA_TIME_ZONE,
  showPacing: envOnOff(process.env.CODEX_QUOTA_SHOW_PACING, true),
  board: () => boardResolver.resolve(),
  statusMessage: () => boardResolver.resolution().source === "assumed" ? "VB SIZE PEND" : undefined,
  autoStartWindow5h: envFlag(process.env.CODEX_AUTO_START_WINDOW_5H),
  autoStartWindowWk: envFlag(process.env.CODEX_AUTO_START_WINDOW_WK),
  takeDemoMode: () => runtimeSignals.takeDemo(),
  restoreDemoMode: (demo) => runtimeSignals.restoreDemo(demo),
  demoDurationMs: demoPauseMinutes * 60_000
});
const plugins = [codexQuotaPlugin];
const delivery = new DeliveryController({
  intervalMs: intervalMinutes * 60_000,
  send: (message) => vestaboard.send(message)
});
const collection = new CollectionController({
  intervalMs: quotaPollIntervalSeconds * 1_000,
  collect: () => codexQuotaPlugin.collect(),
  onCollected: async () => {
    const update = await codexQuotaPlugin.renderUpdate({ consumeDemo: false });
    delivery.updateFrame(update.message);
  }
});
const runtime = new RuntimeController({
  collect: collection,
  delivery,
  render: () => codexQuotaPlugin.renderUpdate(),
  startup,
  startupHoldMs,
  sleep: (ms) => runtimeSignals.sleep(ms),
  wake: () => runtimeSignals.wakeNow(),
  afterSleep: () => {
    if (runtimeSignals.takeRefreshRequest()) {
      collection.requestNow();
    }
  },
  waitOverride: (defaultMs) => runtimeSignals.takePauseAfterDemoRun()
    ? demoPauseMinutes * 60_000
    : defaultMs
});

if (once) {
  runOnceWithStartup().catch(fail);
} else {
  runtimeSignals.install(console);
  installShutdownHandlers();
  runWithStartupAndRuntimeSignals().catch(fail);
}

function fail(error: unknown): void {
  console.error(error);
  process.exitCode = 1;
}

async function runOnceWithStartup(): Promise<void> {
  const startupAttempt = await delivery.deliverStartup(await startup(), startupHoldMs);
  if (startupAttempt.outcome === "sent") {
    await runtimeSignals.sleep(startupHoldMs);
  }
  await codexQuotaPlugin.collect();
  const update = await codexQuotaPlugin.renderUpdate();
  delivery.updateFrame(update.message);
  await delivery.attempt();
  await delivery.stop();
  await collection.stop();
}

async function runWithStartupAndRuntimeSignals(): Promise<void> {
  await runtime.start();
}

async function startup() {
  return formatStartupMessage({
    plugins,
    now: new Date(),
    timeZone: process.env.CODEX_QUOTA_TIME_ZONE,
    board: await boardResolver.resolve(),
    transport: vestaboardTransport,
    statusLine: localMessageTransition.hasError ? "check logs" : undefined
  });
}

function installShutdownHandlers(): void {
  const shutdown = (): void => {
    void runtime.stop().then(() => {
      runtimeSignals.uninstall();
    }, fail);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function positiveEnvNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

function envFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

function envOnOff(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.toLowerCase();
  if (normalized === "off" || normalized === "false" || normalized === "0") return false;
  if (normalized === "on" || normalized === "true" || normalized === "1") return true;
  return defaultValue;
}
