import { ConfigStore } from "./config.js";
import { composeElements } from "./elements.js";
import { createCodexElements, defaultCodexLayout } from "./plugins/codexQuota/elements.js";
import { applyCodexQuotaDemo } from "./plugins/codexQuota/demo.js";
import { createCodexQuotaPlugin } from "./plugins/codexQuota/index.js";
import { CollectionController } from "./runtime/collection.js";
import { DeliveryController } from "./runtime/delivery.js";
import { RuntimeController } from "./runtime/runtime.js";
import { RuntimeSignalController } from "./runtimeSignals.js";
import { formatStartupMessage } from "./startupMessage.js";
import { createVestaboardBoardResolver } from "./vestaboardBoard.js";
import { createVestaboardClient } from "./vestaboard.js";

const configStore = await ConfigStore.open();
if (configStore.repairError) throw new Error(`Fix configuration: ${configStore.repairError}`);
const config = configStore.get();
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const once = args.includes("--once");
const intervalMinutes = config.updateIntervalMinutes;
const quotaPollIntervalSeconds = config.codex.pollIntervalSeconds;
const startupHoldMs = 30_000;
const vestaboardTransport = config.transport.localApiKey ? "local" : "cloud";
const demoPauseMinutes = config.codex.demoPauseMinutes;
const runtimeSignals = new RuntimeSignalController();
const vestaboard = createVestaboardClient({ dryRun, ...config.transport });
const boardResolver = createVestaboardBoardResolver({
  preference: config.board,
  detectBoard: vestaboard.detectBoard,
  logger: console
});

const codexQuotaPlugin = createCodexQuotaPlugin({
  fixture: config.codex.source === "fixture",
  priority: process.env.CODEX_QUOTA_PRIORITY ?? "normal",
  errorPriority: process.env.CODEX_QUOTA_ERROR_PRIORITY ?? "low",
  timeZone: config.codex.timeZone,
  showPacing: config.codex.showPacing,
  board: () => boardResolver.resolve(),
  statusMessage: () => boardResolver.resolution().source === "assumed" ? "VB SIZE PEND" : undefined,
  autoStartWindow5h: config.codex.autoStartWindow5h,
  autoStartWindowWk: config.codex.autoStartWindowWk,
  takeDemoMode: () => runtimeSignals.takeDemo(),
  restoreDemoMode: (demo) => runtimeSignals.restoreDemo(demo),
  demoDurationMs: demoPauseMinutes * 60_000
});
const plugins = config.codex.enabled ? [codexQuotaPlugin] : [];
const delivery = new DeliveryController({
  intervalMs: intervalMinutes * 60_000,
  send: (message) => vestaboard.send(message)
});
const collection = new CollectionController({
  intervalMs: quotaPollIntervalSeconds * 1_000,
  collect: async () => { if (config.codex.enabled) await codexQuotaPlugin.collect(); },
  onCollected: async () => {
    const update = await renderComposed();
    delivery.updateFrame(update.message);
  }
});
const runtime = new RuntimeController({
  collect: collection,
  delivery,
  render: renderComposed,
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
  if (config.codex.enabled) await codexQuotaPlugin.collect();
  const update = await renderComposed();
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
    timeZone: config.codex.timeZone,
    board: await boardResolver.resolve(),
    transport: vestaboardTransport,
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

async function renderComposed() {
  const board = await boardResolver.resolve();
  const state = codexQuotaPlugin.getDisplayState();
  if (state.snapshot) state.snapshot = applyCodexQuotaDemo(state.snapshot, state.presentationDemo);
  const elements = createCodexElements(() => state);
  return {
    priority: "normal" as const,
    message: composeElements(elements, config.layout ?? (config.codex.enabled ? defaultCodexLayout(board) : []), {
      width: board === "note" ? 15 : 22,
      height: board === "note" ? 3 : 6
    })
  };
}
