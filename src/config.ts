import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppConfigSchema, type AppConfig, type ConfigPatch, type HAConfig, type LayoutEntry, type LocalMessageTransitionOptions, type LocalMessageTransitionStrategy, type PublicConfig, type WaterHeaterConfig, PublicConfigSchema } from "./contracts/config.js";
import { DEFAULT_WATER_HEATER_CONFIG, normalizeLegacyWaterHeaterConfig } from "./plugins/waterHeater/config.js";
import { applyCodexEnvironment, DEFAULT_CODEX_CONFIG } from "./plugins/codexQuota/config.js";
import { DEFAULT_LOCAL_MESSAGE_TRANSITION_OPTIONS } from "./vestaboard.js";
import { defaultPauseOverlay } from "./pauseOverlay.js";

export type { AppConfig, ConfigPatch, HAConfig, LayoutEntry, LocalMessageTransitionOptions, LocalMessageTransitionStrategy, PublicConfig } from "./contracts/config.js";
export { AppConfigSchema, PublicConfigSchema } from "./contracts/config.js";

export interface ConfigEnvironment {
  [name: string]: string | undefined;
}

/** Environment names that can seed a missing config file exactly once. */
const LEGACY_PERSISTENT_ENVIRONMENT_VARIABLES = [
  "VESTABOARD_BOARD",
  "VESTABOARD_TOKEN",
  "VESTABOARD_LOCAL_API_KEY",
  "VESTABOARD_CLOUD_URL",
  "VESTABOARD_LOCAL_URL",
  "VESTABOARD_LOCAL_MESSAGE_STRATEGY",
  "VESTABOARD_LOCAL_MESSAGE_STEP_INTERVAL_MS",
  "VESTABOARD_LOCAL_MESSAGE_STEP_SIZE",
  "ORCHESTRATOR_INTERVAL_MINUTES",
  "CODEX_QUOTA_ENABLED",
  "CODEX_QUOTA_SOURCE",
  "CODEX_QUOTA_POLL_INTERVAL_SECONDS",
  "CODEX_QUOTA_TIME_ZONE",
  "CODEX_QUOTA_SHOW_PACING",
  "CODEX_AUTO_START_WINDOW_5H",
  "CODEX_AUTO_START_WINDOW_WK"
] as const;

const OBSOLETE_ENVIRONMENT_VARIABLES = [
  "CODEX_QUOTA_PRIORITY",
  "CODEX_QUOTA_ERROR_PRIORITY",
  "CODEX_QUOTA_DEMO_PAUSE_MINUTES"
] as const;

export const DEFAULT_APP_CONFIG: AppConfig = {
  board: "auto",
  ha: {
    url: "",
    pause: null
  },
  water: { ...DEFAULT_WATER_HEATER_CONFIG },
  transport: {
    cloudUrl: "https://cloud.vestaboard.com/",
    localUrl: "http://vestaboard.local:7000/local-api/message",
    localMessageTransition: { ...DEFAULT_LOCAL_MESSAGE_TRANSITION_OPTIONS }
  },
  updateIntervalMinutes: 5,
  codex: { ...DEFAULT_CODEX_CONFIG },
  layout: null,
  pauseOverlay: defaultPauseOverlay()
};

export class ConfigStore {
  private constructor(
    private readonly filePath: string,
    private readonly legacyEnvironmentVariables: string[],
    private saved: AppConfig | undefined,
    private savedError: string | undefined
  ) {}

  static async open(
    dataDir: string | undefined = undefined,
    env: ConfigEnvironment = process.env
  ): Promise<ConfigStore> {
    const filePath = join(dataDir ?? env.VBMUX_DATA_DIR ?? "./data", "config.json");
    const legacyEnvironmentVariables = legacyEnvironmentNames(env);
    let saved: AppConfig | undefined;
    let savedError: string | undefined;
    let missing = false;
    try {
      const raw = await readFile(filePath, "utf8");
      try {
        saved = validateConfig(mergeConfig(DEFAULT_APP_CONFIG, parseSavedConfig(raw)));
      } catch (error) {
        savedError = errorMessage(error);
      }
    } catch (error) {
      if (isMissingFile(error)) {
        missing = true;
      } else {
        savedError = `Unable to read config: ${errorMessage(error)}`;
      }
    }

    warnObsoleteEnvironmentVariables(env);
    if (missing) {
      try {
        saved = validateConfig(legacyConfig(env));
        await persistConfig(filePath, saved);
      } catch (error) {
        saved = undefined;
        savedError = `Unable to initialize config: ${errorMessage(error)}`;
      }
    }

    return new ConfigStore(filePath, legacyEnvironmentVariables, saved, savedError);
  }

  /** Returns the persisted configuration, or defaults while an invalid file is repaired. */
  get(): AppConfig {
    return cloneConfig(this.saved ?? DEFAULT_APP_CONFIG);
  }

  getPublic(): PublicConfig {
    const config = this.get();
    const hasSecrets = {
      token: Boolean(config.transport.token),
      localApiKey: Boolean(config.transport.localApiKey),
      haToken: Boolean(config.ha.token)
    };
    delete config.transport.token;
    delete config.transport.localApiKey;
    delete config.ha.token;

    return {
      config,
      legacyEnvironmentVariables: [...this.legacyEnvironmentVariables],
      hasSecrets,
      ...(this.savedError ? { error: this.savedError } : {})
    };
  }

  preview(input: ConfigPatch): AppConfig {
    return validateConfig(mergeConfig(this.saved ?? DEFAULT_APP_CONFIG, input));
  }

  /**
   * Validate and persist a configuration atomically. Secret fields omitted by
   * an editor are retained from the saved file; an explicit empty string clears
   * the corresponding secret.
   */
  async save(input: ConfigPatch): Promise<AppConfig> {
    const savedBase = this.saved ?? DEFAULT_APP_CONFIG;
    const candidate = mergeConfig(savedBase, input);
    const validated = validateConfig(candidate);
    await persistConfig(this.filePath, validated);
    this.saved = validated;
    this.savedError = undefined;
    return this.get();
  }

  get repairError(): string | undefined {
    return this.savedError;
  }

}

function parseSavedConfig(raw: string): Partial<AppConfig> {
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch {
    // JSON parser diagnostics can quote the malformed input, including tokens.
    throw new Error("Saved configuration is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Config must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error("Config version must be 1.");
  }
  const { version: _version, ...config } = record;
  if (config.codex && typeof config.codex === "object" && !Array.isArray(config.codex)) {
    const { demoPauseMinutes: _demoPauseMinutes, ...codex } = config.codex as Record<string, unknown>;
    return normalizeLegacyWaterHeaterConfig({ ...config, codex }) as Partial<AppConfig>;
  }
  return normalizeLegacyWaterHeaterConfig(config) as Partial<AppConfig>;
}

function legacyConfig(env: ConfigEnvironment): AppConfig {
  const config = cloneConfig(DEFAULT_APP_CONFIG);
  if (env.VESTABOARD_BOARD) config.board = boardFromEnv(env.VESTABOARD_BOARD);
  if (env.VESTABOARD_TOKEN) config.transport.token = env.VESTABOARD_TOKEN;
  if (env.VESTABOARD_LOCAL_API_KEY) config.transport.localApiKey = env.VESTABOARD_LOCAL_API_KEY;
  if (env.VESTABOARD_CLOUD_URL) config.transport.cloudUrl = env.VESTABOARD_CLOUD_URL;
  if (env.VESTABOARD_LOCAL_URL) config.transport.localUrl = env.VESTABOARD_LOCAL_URL;
  if (env.VESTABOARD_LOCAL_MESSAGE_STRATEGY) config.transport.localMessageTransition.strategy = strategyFromEnv(env.VESTABOARD_LOCAL_MESSAGE_STRATEGY);
  if (env.VESTABOARD_LOCAL_MESSAGE_STEP_INTERVAL_MS) config.transport.localMessageTransition.stepIntervalMs = positiveNumber(env.VESTABOARD_LOCAL_MESSAGE_STEP_INTERVAL_MS, "VESTABOARD_LOCAL_MESSAGE_STEP_INTERVAL_MS");
  if (env.VESTABOARD_LOCAL_MESSAGE_STEP_SIZE) config.transport.localMessageTransition.stepSize = positiveNumber(env.VESTABOARD_LOCAL_MESSAGE_STEP_SIZE, "VESTABOARD_LOCAL_MESSAGE_STEP_SIZE");
  if (env.ORCHESTRATOR_INTERVAL_MINUTES) config.updateIntervalMinutes = positiveNumber(env.ORCHESTRATOR_INTERVAL_MINUTES, "ORCHESTRATOR_INTERVAL_MINUTES");
  config.codex = applyCodexEnvironment(config.codex, env);
  return config;
}

function positiveNumber(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

async function persistConfig(filePath: string, config: AppConfig): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ version: 1, ...config }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function legacyEnvironmentNames(env: ConfigEnvironment): string[] {
  return [...LEGACY_PERSISTENT_ENVIRONMENT_VARIABLES, ...OBSOLETE_ENVIRONMENT_VARIABLES]
    .filter((name) => env[name] !== undefined && env[name] !== "");
}

function warnObsoleteEnvironmentVariables(env: ConfigEnvironment): void {
  const names = OBSOLETE_ENVIRONMENT_VARIABLES.filter((name) => env[name] !== undefined && env[name] !== "");
  if (names.length > 0) console.warn(`Ignoring obsolete environment variables: ${names.join(", ")}.`);
}

function mergeConfig(base: AppConfig, patch: ConfigPatch): AppConfig {
  const baseConfig = cloneConfig(base);
  const haPatch = patch.ha;
  const transport = patch.transport ?? {};
  const codex: Partial<AppConfig["codex"]> = patch.codex ?? {};
  const ha = haPatch === undefined
    ? baseConfig.ha
    : haPatch === null
      ? null as unknown as HAConfig
      : {
          ...baseConfig.ha,
          ...haPatch,
          ...(haPatch.token === undefined && baseConfig.ha.token !== undefined ? { token: baseConfig.ha.token } : {})
        };
  const water = patch.water === undefined
    ? baseConfig.water
    : patch.water === null
      ? null as unknown as WaterHeaterConfig
      : { ...baseConfig.water, ...patch.water };
  return {
    ...baseConfig,
    ...patch,
    ha,
    water,
    transport: {
      ...baseConfig.transport,
      ...transport,
      localMessageTransition: {
        ...baseConfig.transport.localMessageTransition,
        ...(transport.localMessageTransition ?? {})
      }
    },
    codex: {
      ...baseConfig.codex,
      ...codex
    },
    layout: patch.layout === undefined ? cloneConfig(base).layout : patch.layout,
    pauseOverlay: {
      note: patch.pauseOverlay?.note === undefined ? baseConfig.pauseOverlay.note : structuredClone(patch.pauseOverlay.note),
      flagship: patch.pauseOverlay?.flagship === undefined ? baseConfig.pauseOverlay.flagship : structuredClone(patch.pauseOverlay.flagship)
    }
  } as AppConfig;
}

function cloneConfig(config: AppConfig): AppConfig {
  return structuredClone(config);
}

export function validateConfig(config: unknown): AppConfig {
  const result = AppConfigSchema.safeParse(config);
  if (!result.success) throw new Error(result.error.issues.map((issue) => `${issue.path.join(".") || "config"} ${issue.message}`).join("; "));
  return cloneConfig(result.data);
}

function boardFromEnv(value: string): AppConfig["board"] {
  if (value === "auto" || value === "note" || value === "flagship") return value;
  throw new Error("VESTABOARD_BOARD must be auto, note, or flagship.");
}

function strategyFromEnv(value: string): LocalMessageTransitionStrategy {
  if (["column", "reverse-column", "edges-to-center", "row", "diagonal", "random"].includes(value)) return value as LocalMessageTransitionStrategy;
  throw new Error("VESTABOARD_LOCAL_MESSAGE_STRATEGY is invalid.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
}
