import { LegacyCodexQuotaAdapter } from "./plugins/codexQuota/legacyAdapter.js";
import { LastSentMessageCache, runForever, tick } from "./orchestrator.js";
import { sendStartupMessage } from "./startupMessage.js";
import { boardPreferenceFromEnv, createVestaboardBoardResolver } from "./vestaboardBoard.js";
import { createVestaboardClient, localMessageTransitionOptionsFromEnv } from "./vestaboard.js";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const once = args.includes("--once");
const intervalMinutes = Number(process.env.ORCHESTRATOR_INTERVAL_MINUTES ?? "5");
const startupPollDelayMs = 60_000;
const vestaboardTransport = process.env.VESTABOARD_LOCAL_API_KEY ? "local" : "cloud";
const sentMessageCache = new LastSentMessageCache();
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

const plugins = [
  new LegacyCodexQuotaAdapter({
    fixture: process.env.CODEX_QUOTA_SOURCE === "fixture",
    priority: process.env.CODEX_QUOTA_PRIORITY ?? "normal",
    errorPriority: process.env.CODEX_QUOTA_ERROR_PRIORITY ?? "low",
    timeZone: process.env.CODEX_QUOTA_TIME_ZONE,
    showPacing: envOnOff(process.env.CODEX_QUOTA_SHOW_PACING, true),
    board: () => boardResolver.resolve(),
    statusMessage: () => boardResolver.resolution().source === "assumed" ? "VB SIZE PEND" : undefined,
    autoStartWindow5h: envFlag(process.env.CODEX_AUTO_START_WINDOW_5H),
    autoStartWindowWk: envFlag(process.env.CODEX_AUTO_START_WINDOW_WK)
  })
];

async function run(): Promise<void> {
  await tick({ plugins, vestaboard, sentMessageCache });
}

if (once) {
  runOnceWithStartup().catch(fail);
} else {
  runWithStartupAndPolling().catch(fail);
}

function fail(error: unknown): void {
  console.error(error);
  process.exitCode = 1;
}

async function runOnceWithStartup(): Promise<void> {
  await startup();
  await run();
}

async function runWithStartupAndPolling(): Promise<void> {
  let stopping = false;
  const stop = (): void => { stopping = true; };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await startup();
    if (!stopping) {
      await runForever({ runOnce: run, waitMs: intervalMinutes * 60_000, shouldContinue: () => !stopping });
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

async function startup(): Promise<void> {
  await sendStartupMessage({
    plugins,
    vestaboard,
    board: () => boardResolver.resolve(),
    transport: vestaboardTransport,
    timeZone: process.env.CODEX_QUOTA_TIME_ZONE,
    statusLine: localMessageTransition.hasError ? "check logs" : undefined
  });
  await new Promise<void>((resolve) => setTimeout(resolve, startupPollDelayMs));
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
