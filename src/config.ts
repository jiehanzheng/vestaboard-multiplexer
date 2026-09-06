import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppConfigSchema, type AppConfig, type HAConfig, type LayoutEntry, type LocalMessageTransitionOptions, type LocalMessageTransitionStrategy, type PublicConfig, type WaterHeaterConfig, PublicConfigSchema } from "./contracts/config.js";
import { DEFAULT_WATER_HEATER_CONFIG } from "./plugins/waterHeater/config.js";
import {
  DEFAULT_LOCAL_MESSAGE_TRANSITION_OPTIONS
} from "./vestaboard.js";

export type { AppConfig, HAConfig, LayoutEntry, LocalMessageTransitionOptions, LocalMessageTransitionStrategy, PublicConfig } from "./contracts/config.js";
export { AppConfigSchema, PublicConfigSchema } from "./contracts/config.js";

export interface ConfigEnvironment {
  [name: string]: string | undefined;
}

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
  codex: {
    enabled: true,
    source: "app-server",
    pollIntervalSeconds: 60,
    showPacing: true,
    autoStartWindow5h: false,
    autoStartWindowWk: false,
    demoPauseMinutes: 5
  },
  layout: null
};

export class ConfigStore {
  private constructor(
    private readonly filePath: string,
    private readonly env: ConfigEnvironment,
    private saved: AppConfig | undefined,
    private savedError: string | undefined
  ) {}

  static async open(
    dataDir: string | undefined = undefined,
    env: ConfigEnvironment = process.env
  ): Promise<ConfigStore> {
    const filePath = join(dataDir ?? env.VBMUX_DATA_DIR ?? "./data", "config.json");
    let saved: AppConfig | undefined;
    let savedError: string | undefined;
    try {
      const raw = await readFile(filePath, "utf8");
      try {
        saved = validateConfig(mergeConfig(DEFAULT_APP_CONFIG, parseSavedConfig(JSON.parse(raw))));
      } catch (error) {
        savedError = errorMessage(error);
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        savedError = `Unable to read config: ${errorMessage(error)}`;
      }
    }

    return new ConfigStore(filePath, env, saved, savedError);
  }

  /** Effective configuration after saved values and environment overrides. */
  get(): AppConfig {
    return this.effective().config;
  }

  getPublic(): PublicConfig {
    const environment = this.effective();
    const config = cloneConfig(environment.config);
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
      locked: environment.locked,
      hasSecrets,
      ...((this.savedError ?? environment.error) ? { error: this.savedError ?? environment.error } : {})
    };
  }

  preview(input: AppConfig): AppConfig {
    const candidate = validateConfig(mergeConfig(this.saved ?? DEFAULT_APP_CONFIG, input));
    return applyEnvironment(candidate, this.env).config;
  }

  /**
   * Validate and persist a configuration atomically. Secret fields omitted by
   * an editor are retained from the saved file; an explicit empty string clears
   * the corresponding secret.
   */
  async save(input: AppConfig): Promise<AppConfig> {
    const savedBase = this.saved ?? DEFAULT_APP_CONFIG;
    const candidate = mergeConfig(savedBase, input);
    const locked = applyEnvironment(cloneConfig(savedBase), this.env).locked;
    for (const path of locked) {
      setConfigPath(candidate, path, getConfigPath(savedBase, path));
    }
    const validated = validateConfig(candidate);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify({ version: 1, ...validated }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.filePath);
    this.saved = validated;
    this.savedError = undefined;
    return this.get();
  }

  get repairError(): string | undefined {
    return this.savedError;
  }

  private effective(): { config: AppConfig; locked: string[]; error?: string } {
    const baseline = mergeConfig(DEFAULT_APP_CONFIG, this.saved ?? {});
    try {
      return applyEnvironment(baseline, this.env);
    } catch (error) {
      return {
        config: baseline,
        locked: [],
        error: `Invalid environment configuration: ${errorMessage(error)}`
      };
    }
  }
}

function parseSavedConfig(value: unknown): Partial<AppConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Config must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error("Config version must be 1.");
  }
  const { version: _version, ...config } = record;
  return config as unknown as AppConfig;
}

function applyEnvironment(base: AppConfig, env: ConfigEnvironment): { config: AppConfig; locked: string[] } {
  const config = cloneConfig(base);
  const locked: string[] = [];
  const set = <T>(path: string, value: T, apply: () => void): void => {
    if (value !== undefined && value !== "") {
      apply();
      locked.push(path);
    }
  };

  set("board", env.VESTABOARD_BOARD, () => {
    config.board = boardFromEnv(env.VESTABOARD_BOARD!);
  });
  set("transport.token", env.VESTABOARD_TOKEN, () => { config.transport.token = env.VESTABOARD_TOKEN; });
  set("transport.localApiKey", env.VESTABOARD_LOCAL_API_KEY, () => { config.transport.localApiKey = env.VESTABOARD_LOCAL_API_KEY; });
  set("transport.cloudUrl", env.VESTABOARD_CLOUD_URL, () => { config.transport.cloudUrl = env.VESTABOARD_CLOUD_URL!; });
  set("transport.localUrl", env.VESTABOARD_LOCAL_URL, () => { config.transport.localUrl = env.VESTABOARD_LOCAL_URL!; });
  set("transport.localMessageTransition.strategy", env.VESTABOARD_LOCAL_MESSAGE_STRATEGY, () => {
    config.transport.localMessageTransition.strategy = strategyFromEnv(env.VESTABOARD_LOCAL_MESSAGE_STRATEGY!);
  });
  setNumber("transport.localMessageTransition.stepIntervalMs", env.VESTABOARD_LOCAL_MESSAGE_STEP_INTERVAL_MS, (value) => {
    config.transport.localMessageTransition.stepIntervalMs = value;
  }, locked);
  setNumber("transport.localMessageTransition.stepSize", env.VESTABOARD_LOCAL_MESSAGE_STEP_SIZE, (value) => {
    config.transport.localMessageTransition.stepSize = value;
  }, locked);
  setNumber("updateIntervalMinutes", env.ORCHESTRATOR_INTERVAL_MINUTES, (value) => {
    config.updateIntervalMinutes = value;
  }, locked);
  set("codex.enabled", env.CODEX_QUOTA_ENABLED, () => { config.codex.enabled = boolFromEnv(env.CODEX_QUOTA_ENABLED!); });
  set("codex.source", env.CODEX_QUOTA_SOURCE, () => { config.codex.source = sourceFromEnv(env.CODEX_QUOTA_SOURCE!); });
  setNumber("codex.pollIntervalSeconds", env.CODEX_QUOTA_POLL_INTERVAL_SECONDS, (value) => {
    config.codex.pollIntervalSeconds = value;
  }, locked);
  set("codex.timeZone", env.CODEX_QUOTA_TIME_ZONE, () => { config.codex.timeZone = env.CODEX_QUOTA_TIME_ZONE; });
  set("codex.showPacing", env.CODEX_QUOTA_SHOW_PACING, () => { config.codex.showPacing = onOffFromEnv(env.CODEX_QUOTA_SHOW_PACING!); });
  set("codex.autoStartWindow5h", env.CODEX_AUTO_START_WINDOW_5H, () => { config.codex.autoStartWindow5h = boolFromEnv(env.CODEX_AUTO_START_WINDOW_5H!); });
  set("codex.autoStartWindowWk", env.CODEX_AUTO_START_WINDOW_WK, () => { config.codex.autoStartWindowWk = boolFromEnv(env.CODEX_AUTO_START_WINDOW_WK!); });
  setNumber("codex.demoPauseMinutes", env.CODEX_QUOTA_DEMO_PAUSE_MINUTES, (value) => {
    config.codex.demoPauseMinutes = value;
  }, locked);

  return { config: validateConfig(config), locked };
}

function setNumber(path: string, raw: string | undefined, apply: (value: number) => void, locked: string[]): void {
  if (raw === undefined || raw === "") return;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a positive number.`);
  }
  apply(value);
  locked.push(path);
}

function mergeConfig(base: AppConfig, patch: Partial<AppConfig>): AppConfig {
  const baseConfig = cloneConfig(base);
  const haPatch = patch.ha;
  const transport: Partial<AppConfig["transport"]> = patch.transport ?? {};
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
    layout: patch.layout === undefined ? cloneConfig(base).layout : patch.layout
  } as AppConfig;
}

function cloneConfig(config: AppConfig): AppConfig {
  return structuredClone(config);
}

function getConfigPath(config: AppConfig, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => (
    value && typeof value === "object" ? (value as Record<string, unknown>)[segment] : undefined
  ), config);
}

function setConfigPath(config: AppConfig, path: string, value: unknown): void {
  const segments = path.split(".");
  const leaf = segments.pop();
  if (!leaf) return;
  let target: Record<string, unknown> = config as unknown as Record<string, unknown>;
  for (const segment of segments) {
    const next = target[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    target = next as Record<string, unknown>;
  }
  target[leaf] = value;
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

function sourceFromEnv(value: string): AppConfig["codex"]["source"] {
  if (value === "fixture" || value === "app-server") return value;
  throw new Error("CODEX_QUOTA_SOURCE must be fixture or app-server.");
}

function strategyFromEnv(value: string): LocalMessageTransitionStrategy {
  if (["column", "reverse-column", "edges-to-center", "row", "diagonal", "random"].includes(value)) return value as LocalMessageTransitionStrategy;
  throw new Error("VESTABOARD_LOCAL_MESSAGE_STRATEGY is invalid.");
}

function boolFromEnv(value: string): boolean {
  if (["1", "true", "on", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "off", "no"].includes(value.toLowerCase())) return false;
  throw new Error(`Invalid boolean environment value '${value}'.`);
}

function onOffFromEnv(value: string): boolean {
  return boolFromEnv(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
}
