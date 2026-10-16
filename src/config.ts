import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { supportedElementIds } from "./elementCatalog.js";
import { intervalLimit } from "./contracts/updateLimits.js";
import { mergeHABlocks, normalizeLegacyHABlocks } from "./plugins/haBlock/config.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppConfigSchema, ConfigPatchSchema, type AppConfig, type ConfigPatch, type HAConfig, type LayoutEntry, type LocalMessageTransitionOptions, type LocalMessageTransitionStrategy, type PublicConfig, PublicConfigSchema } from "./contracts/config.js";
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
  haBlocks: [],
  barRows: [],
  transport: {
    cloudUrl: "https://cloud.vestaboard.com/",
    localUrl: "http://vestaboard.local:7000/local-api/message",
    localMessageTransition: { ...DEFAULT_LOCAL_MESSAGE_TRANSITION_OPTIONS }
  },
  updateLimits: intervalLimit(5),
  codex: { ...DEFAULT_CODEX_CONFIG },
  layout: null,
  pauseOverlay: defaultPauseOverlay()
};

export class ConfigStore {
  private constructor(
    private readonly filePath: string,
    private readonly legacyEnvironmentVariables: string[],
    private saved: AppConfig | undefined,
    private savedError: string | undefined,
    private retired: RetiredConfig = emptyRetired()
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
    let retired = emptyRetired();
    try {
      const raw = await readFile(filePath, "utf8");
      try {
        const parsed = parseSavedConfig(raw);
        retired = parsed.retired;
        saved = validateConfig(mergeConfig(DEFAULT_APP_CONFIG, parsed.config));
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

    if (hasRetired(retired)) console.warn("Ignored unsupported saved configuration keys or layout elements. Remove ignored configuration in Settings to clean the saved file.");
    return new ConfigStore(filePath, legacyEnvironmentVariables, saved, savedError, retired);
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
      ignoredConfiguration: { keys: [...new Set(this.retired.flatMap((record) => Object.keys(record.keys)))], elementIds: [...new Set(this.retired.flatMap((record) => record.placements.map(({ value }) => value.elementId)))] },
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
    const retired = input.removeUnsupportedPlugins ? emptyRetired() : this.retired;
    const persisted = restoreRetired(validated, retired);
    await persistConfig(this.filePath, persisted);
    this.retired = captureRetired(persisted).retired;
    this.saved = validated;
    this.savedError = undefined;
    return this.get();
  }

  get repairError(): string | undefined {
    return this.savedError;
  }

}

function parseSavedConfig(raw: string): { config: Partial<AppConfig>; retired: RetiredConfig } {
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
  const { version: _version, ...savedConfig } = record;
  const normalized = normalizeLegacyHABlocks(savedConfig) as Record<string, unknown>;
  if (normalized.codex && typeof normalized.codex === "object" && !Array.isArray(normalized.codex)) {
    const { demoPauseMinutes: _demoPauseMinutes, ...codex } = normalized.codex as Record<string, unknown>;
    normalized.codex = codex;
  }
  if (normalized.updateIntervalMinutes !== undefined) {
    const legacy = ConfigPatchSchema.pick({ updateIntervalMinutes: true }).parse({ updateIntervalMinutes: normalized.updateIntervalMinutes });
    if (normalized.updateLimits === undefined) normalized.updateLimits = intervalLimit(legacy.updateIntervalMinutes!);
  }
  delete normalized.updateIntervalMinutes;
  const { config, retired } = captureRetired(normalized);
  return { config: config as Partial<AppConfig>, retired };
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
  if (env.ORCHESTRATOR_INTERVAL_MINUTES) config.updateLimits = intervalLimit(positiveNumber(env.ORCHESTRATOR_INTERVAL_MINUTES, "ORCHESTRATOR_INTERVAL_MINUTES"));
  config.codex = applyCodexEnvironment(config.codex, env);
  return config;
}

function positiveNumber(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

async function persistConfig(filePath: string, config: object): Promise<void> {
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
  const { haBlock: legacyBlock, updateIntervalMinutes: legacyInterval, removeUnsupportedPlugins: _cleanup, ...canonicalPatch } = patch;
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
  return {
    ...baseConfig,
    ...canonicalPatch,
    updateLimits: patch.updateLimits === undefined ? (legacyInterval === undefined ? baseConfig.updateLimits : intervalLimit(legacyInterval)) : patch.updateLimits,
    ha,
    haBlocks: mergeHABlocks(baseConfig.haBlocks, patch.haBlocks, legacyBlock),
    transport: {
      ...baseConfig.transport,
      ...transport,
      localMessageTransition: {
        ...baseConfig.transport.localMessageTransition,
        ...(transport.localMessageTransition ?? {})
      },
      pauseMessageTransition: transport.pauseMessageTransition === null
        ? undefined
        : transport.pauseMessageTransition === undefined
          ? baseConfig.transport.pauseMessageTransition
          : {
              ...(baseConfig.transport.pauseMessageTransition ?? {}),
              ...transport.pauseMessageTransition
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

interface RetiredRecord {
  keys: Record<string, unknown>;
  placements: { index: number; value: { elementId: string; [key: string]: unknown } }[];
}
type RetiredConfig = RetiredRecord[];
const rawObjectSchema = z.custom<Record<string, unknown>>((value) => value !== null && typeof value === "object" && !Array.isArray(value), "Expected an object.");
// Keep ignored JSON verbatim, including own keys that object schema parsers may discard.
const rawPlacementSchema = z.custom<{ elementId: string; [key: string]: unknown }>((value) => rawObjectSchema.safeParse(value).success && Object.hasOwn(value as object, "elementId") && typeof (value as { elementId: unknown }).elementId === "string", "Expected a placement object with an elementId string.");
const placementSchema = z.object({ index: z.number().int().nonnegative(), value: rawPlacementSchema }).strict();
const LegacyArchiveSchema = z.object({ version: z.literal(1), records: z.array(z.object({ id: z.literal("water"), settingsPresent: z.boolean(), settings: z.unknown().optional(), placements: z.array(placementSchema) }).strict()) }).strict();
const ArchiveSchema = z.object({ version: z.literal(2), records: z.array(z.object({ keys: rawObjectSchema, placements: z.array(placementSchema) }).strict()) }).strict();
function emptyRetired(): RetiredConfig { return []; }
function hasRetired(value: RetiredConfig): boolean { return value.some((record) => Object.keys(record.keys).length > 0 || record.placements.length > 0); }
function captureRetired(record: Record<string, unknown>): { config: Record<string, unknown>; retired: RetiredConfig } {
  const { retiredPlugins, ...raw } = record;
  let archived: RetiredConfig = [];
  if (retiredPlugins !== undefined) {
    const version = retiredPlugins && typeof retiredPlugins === "object" && "version" in retiredPlugins ? retiredPlugins.version : undefined;
    archived = version === 1 ? LegacyArchiveSchema.parse(retiredPlugins).records.map((entry) => ({ keys: entry.settingsPresent ? { water: entry.settings } : {}, placements: entry.placements })) : ArchiveSchema.parse(retiredPlugins).records;
  }
  const knownKeys = new Set(Object.keys(AppConfigSchema.shape));
  const config = Object.fromEntries(Object.entries(raw).filter(([key]) => knownKeys.has(key)));
  const unknownKeys = Object.fromEntries(Object.entries(raw).filter(([key]) => !knownKeys.has(key)));
  // Validate supported instances before deciding whether a saved placement references one.
  const supported = validateConfig(mergeConfig(DEFAULT_APP_CONFIG, { ...config, layout: null } as ConfigPatch));
  const elementIds = supportedElementIds(supported);
  const legacy: RetiredRecord = { keys: structuredClone(unknownKeys), placements: [] };
  if (Array.isArray(config.layout)) config.layout = config.layout.filter((value, index) => {
    if (value && typeof value === "object" && typeof value.elementId === "string" && !elementIds.has(value.elementId)) {
      legacy.placements.push({ index, value: structuredClone(value) }); return false;
    }
    return true;
  });
  const candidates = [...archived, ...(hasRetired([legacy]) ? [legacy] : [])];
  const retired = candidates.filter((candidate, index) => !candidates.slice(0, index).some((previous) => isDeepStrictEqual(previous, candidate)));
  return { config, retired };
}
function restoreRetired(config: AppConfig, retired: RetiredConfig): Record<string, unknown> {
  const result: Record<string, unknown> = structuredClone(config);
  // Archive ignored data separately so supported layout:null keeps its default-layout meaning.
  if (hasRetired(retired)) result.retiredPlugins = { version: 2, records: structuredClone(retired) };
  return result;
}
