import { z } from "zod";
import { charCode } from "../../vestaboardCharacters.js";

const displayLabelText = z.string()
  .refine((value) => {
    const length = [...value].length;
    return length >= 1 && length <= 2;
  }, "must be 1 or 2 characters")
  .refine((value) => value === value.toUpperCase(), "must use uppercase characters")
  .refine((value) => {
    try {
      for (const character of value) charCode(character);
      return true;
    } catch {
      return false;
    }
  }, "must use supported Vestaboard characters");

const displayLabel = displayLabelText.nullable();

const codexConfigShape = {
  staleAfterMinutes: z.number().finite().positive().nullable().optional(),
  enabled: z.boolean(),
  source: z.enum(["fixture", "app-server"]),
  pollIntervalSeconds: z.number().finite().positive(),
  timeZone: z.string().refine(isValidTimeZone, "must be a valid time zone").optional(),
  showPacing: z.boolean(),
  autoStartWindow5h: z.boolean(),
  autoStartWindowWk: z.boolean(),
  window1Label: displayLabel,
  window2Label: displayLabel
};

export const CodexConfigSchema = z.object({
  ...codexConfigShape,
  window1Label: displayLabel.default(null),
  window2Label: displayLabel.default(null)
}).strict();

/** Patch fields stay optional so omitted labels cannot reset saved choices. */
export const CodexConfigPatchSchema = z.object(codexConfigShape).partial().strict();

export type CodexConfig = z.infer<typeof CodexConfigSchema>;

export const DEFAULT_CODEX_CONFIG: CodexConfig = {
  enabled: true,
  source: "app-server",
  pollIntervalSeconds: 60,
  showPacing: true,
  autoStartWindow5h: false,
  autoStartWindowWk: false,
  window1Label: null,
  window2Label: null
};

export interface CodexEnvironment {
  [name: string]: string | undefined;
}

/** Decode Codex-owned environment settings while bootstrapping a missing saved configuration. */
export function applyCodexEnvironment(base: CodexConfig, env: CodexEnvironment): CodexConfig {
  const config = { ...base };
  const set = (raw: string | undefined, apply: (value: string) => void): void => {
    if (raw !== undefined && raw !== "") {
      apply(raw);
    }
  };
  const setNumber = (path: string, raw: string | undefined, apply: (value: number) => void): void => {
    if (raw === undefined || raw === "") return;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${path} must be a positive number.`);
    apply(value);
  };

  set(env.CODEX_QUOTA_ENABLED, (value) => { config.enabled = boolFromEnv(value, "CODEX_QUOTA_ENABLED"); });
  set(env.CODEX_QUOTA_SOURCE, (value) => { config.source = sourceFromEnv(value); });
  setNumber("codex.pollIntervalSeconds", env.CODEX_QUOTA_POLL_INTERVAL_SECONDS, (value) => { config.pollIntervalSeconds = value; });
  set(env.CODEX_QUOTA_TIME_ZONE, (value) => { config.timeZone = value; });
  set(env.CODEX_QUOTA_SHOW_PACING, (value) => { config.showPacing = boolFromEnv(value, "CODEX_QUOTA_SHOW_PACING"); });
  set(env.CODEX_AUTO_START_WINDOW_5H, (value) => { config.autoStartWindow5h = boolFromEnv(value, "CODEX_AUTO_START_WINDOW_5H"); });
  set(env.CODEX_AUTO_START_WINDOW_WK, (value) => { config.autoStartWindowWk = boolFromEnv(value, "CODEX_AUTO_START_WINDOW_WK"); });
  return config;
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function sourceFromEnv(value: string): CodexConfig["source"] {
  if (value === "fixture" || value === "app-server") return value;
  throw new Error("CODEX_QUOTA_SOURCE must be fixture or app-server.");
}

function boolFromEnv(value: string, name: string): boolean {
  if (["1", "true", "on", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "off", "no"].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean.`);
}
