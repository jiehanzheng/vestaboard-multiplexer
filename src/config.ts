import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LayoutEntry } from "./elements.js";
import type { HAConfig } from "./homeAssistant.js";
import {
  DEFAULT_WATER_HEATER_CONFIG,
  validateWaterHeaterConfig,
  type WaterHeaterConfig
} from "./plugins/waterHeater.js";
import {
  DEFAULT_LOCAL_MESSAGE_TRANSITION_OPTIONS,
  type LocalMessageTransitionOptions,
  type LocalMessageTransitionStrategy
} from "./vestaboard.js";

export type { LayoutEntry } from "./elements.js";

export interface AppConfig {
  board: "auto" | "note" | "flagship";
  ha: HAConfig;
  water: WaterHeaterConfig;
  transport: {
    token?: string;
    localApiKey?: string;
    cloudUrl: string;
    localUrl: string;
    localMessageTransition: LocalMessageTransitionOptions;
  };
  updateIntervalMinutes: number;
  codex: {
    enabled: boolean;
    source: "fixture" | "app-server";
    pollIntervalSeconds: number;
    timeZone?: string;
    showPacing: boolean;
    autoStartWindow5h: boolean;
    autoStartWindowWk: boolean;
    demoPauseMinutes: number;
  };
  layout: LayoutEntry[] | null;
}

export interface PublicConfig {
  config: AppConfig;
  locked: string[];
  hasSecrets: {
    token: boolean;
    localApiKey: boolean;
    haToken: boolean;
  };
  error?: string;
}

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

function parseSavedConfig(value: unknown): AppConfig {
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
  return {
    ...config,
    ha: {
      ...config.ha,
      pause: config.ha.pause ? { ...config.ha.pause } : null
    },
    water: {
      ...config.water,
      remaining: config.water.remaining ? { ...config.water.remaining } : null,
      capacity: config.water.capacity ? { ...config.water.capacity } : null,
      temperature: config.water.temperature ? { ...config.water.temperature } : null,
      target: config.water.target ? { ...config.water.target } : null
    },
    transport: {
      ...config.transport,
      localMessageTransition: { ...config.transport.localMessageTransition }
    },
    codex: { ...config.codex },
    layout: config.layout ? config.layout.map((entry) => ({ ...entry })) : null
  };
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

function validateConfig(config: AppConfig): AppConfig {
  if (!["auto", "note", "flagship"].includes(config.board)) throw new Error("board must be auto, note, or flagship.");
  validateHomeAssistantConfig(config.ha);
  if (!config.water || typeof config.water !== "object") throw new Error("water is required.");
  for (const error of validateWaterHeaterConfig(config.water)) throw new Error(`water.${error}`);
  if (!config.transport || typeof config.transport !== "object") throw new Error("transport is required.");
  if (typeof config.transport.cloudUrl !== "string" || !config.transport.cloudUrl) throw new Error("transport.cloudUrl is required.");
  if (typeof config.transport.localUrl !== "string" || !config.transport.localUrl) throw new Error("transport.localUrl is required.");
  if (config.transport.token !== undefined && typeof config.transport.token !== "string") throw new Error("transport.token must be a string.");
  if (config.transport.localApiKey !== undefined && typeof config.transport.localApiKey !== "string") throw new Error("transport.localApiKey must be a string.");
  validateTransition(config.transport.localMessageTransition);
  positive(config.updateIntervalMinutes, "updateIntervalMinutes");
  if (!config.codex || typeof config.codex !== "object") throw new Error("codex is required.");
  if (!["fixture", "app-server"].includes(config.codex.source)) throw new Error("codex.source must be fixture or app-server.");
  positive(config.codex.pollIntervalSeconds, "codex.pollIntervalSeconds");
  positive(config.codex.demoPauseMinutes, "codex.demoPauseMinutes");
  for (const [path, value] of Object.entries(config.codex)) {
    if (["enabled", "showPacing", "autoStartWindow5h", "autoStartWindowWk"].includes(path) && typeof value !== "boolean") {
      throw new Error(`codex.${path} must be a boolean.`);
    }
  }
  if (config.codex.timeZone !== undefined) {
    if (typeof config.codex.timeZone !== "string") throw new Error("codex.timeZone must be a string.");
    validateTimeZone(config.codex.timeZone);
  }
  if (config.layout !== null) {
    if (!Array.isArray(config.layout)) throw new Error("layout must be an array or null.");
    for (const entry of config.layout) {
      if (!entry || typeof entry.elementId !== "string" || !entry.elementId || !Number.isInteger(entry.startRow) || entry.startRow < 0) {
        throw new Error("layout entries require an elementId and non-negative integer startRow.");
      }
    }
    const temperatureBarAllocated = config.water.enabled && config.layout.some((entry) => entry.elementId === "water.temperature-bar");
    if (temperatureBarAllocated && config.water.baseline === undefined) {
      throw new Error("water.baseline is required when water.temperature-bar is allocated.");
    }
  }
  return cloneConfig(config);
}

function validateHomeAssistantConfig(config: HAConfig): void {
  if (!config || typeof config !== "object") throw new Error("ha is required.");
  if (typeof config.url !== "string") throw new Error("ha.url must be a string.");
  if (config.url !== "") {
    let parsed: URL;
    try {
      parsed = new URL(config.url);
    } catch {
      throw new Error("ha.url must be a valid HTTP(S) URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("ha.url must use HTTP or HTTPS.");
    }
    if (parsed.username || parsed.password) throw new Error("ha.url must not contain embedded credentials.");
  }
  if (config.token !== undefined && typeof config.token !== "string") throw new Error("ha.token must be a string.");
  if (config.pause === null) return;
  if (!config.pause || typeof config.pause !== "object") throw new Error("ha.pause must be an object or null.");
  if (typeof config.pause.entityId !== "string" || !config.pause.entityId.trim()) throw new Error("ha.pause.entityId is required.");
  if (typeof config.pause.pauseValue !== "string" || !config.pause.pauseValue.trim()) throw new Error("ha.pause.pauseValue is required.");
  if (typeof config.pause.resumeValue !== "string" || !config.pause.resumeValue.trim()) throw new Error("ha.pause.resumeValue is required.");
  if (config.pause.pauseValue === config.pause.resumeValue) throw new Error("ha.pause values must be distinct.");
}

function validateTransition(transition: LocalMessageTransitionOptions): void {
  if (!transition || !["column", "reverse-column", "edges-to-center", "row", "diagonal", "random"].includes(transition.strategy)) {
    throw new Error("transport.localMessageTransition.strategy is invalid.");
  }
  positive(transition.stepIntervalMs, "transport.localMessageTransition.stepIntervalMs");
  positive(transition.stepSize, "transport.localMessageTransition.stepSize");
}

function positive(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${path} must be a positive number.`);
}

function validateTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new Error(`Invalid time zone '${timeZone}'.`);
  }
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
