import { z } from "zod";

export const CodexConfigSchema = z.object({
  enabled: z.boolean(),
  source: z.enum(["fixture", "app-server"]),
  pollIntervalSeconds: z.number().finite().positive(),
  timeZone: z.string().refine(isValidTimeZone, "must be a valid time zone").optional(),
  showPacing: z.boolean(),
  autoStartWindow5h: z.boolean(),
  autoStartWindowWk: z.boolean(),
  demoPauseMinutes: z.number().finite().positive()
}).strict();

export type CodexConfig = z.infer<typeof CodexConfigSchema>;

export const DEFAULT_CODEX_CONFIG: CodexConfig = {
  enabled: true,
  source: "app-server",
  pollIntervalSeconds: 60,
  showPacing: true,
  autoStartWindow5h: false,
  autoStartWindowWk: false,
  demoPauseMinutes: 5
};

export interface CodexEnvironment {
  [name: string]: string | undefined;
}

/** Decode only Codex-owned environment settings; persistence owns precedence and locks. */
export function applyCodexEnvironment(base: CodexConfig, env: CodexEnvironment): { config: CodexConfig; locked: string[] } {
  const config = { ...base };
  const locked: string[] = [];
  const set = (path: string, raw: string | undefined, apply: (value: string) => void): void => {
    if (raw !== undefined && raw !== "") {
      apply(raw);
      locked.push(path);
    }
  };
  const setNumber = (path: string, raw: string | undefined, apply: (value: number) => void): void => {
    if (raw === undefined || raw === "") return;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${path} must be a positive number.`);
    apply(value);
    locked.push(path);
  };

  set("codex.enabled", env.CODEX_QUOTA_ENABLED, (value) => { config.enabled = boolFromEnv(value); });
  set("codex.source", env.CODEX_QUOTA_SOURCE, (value) => { config.source = sourceFromEnv(value); });
  setNumber("codex.pollIntervalSeconds", env.CODEX_QUOTA_POLL_INTERVAL_SECONDS, (value) => { config.pollIntervalSeconds = value; });
  set("codex.timeZone", env.CODEX_QUOTA_TIME_ZONE, (value) => { config.timeZone = value; });
  set("codex.showPacing", env.CODEX_QUOTA_SHOW_PACING, (value) => { config.showPacing = boolFromEnv(value); });
  set("codex.autoStartWindow5h", env.CODEX_AUTO_START_WINDOW_5H, (value) => { config.autoStartWindow5h = boolFromEnv(value); });
  set("codex.autoStartWindowWk", env.CODEX_AUTO_START_WINDOW_WK, (value) => { config.autoStartWindowWk = boolFromEnv(value); });
  setNumber("codex.demoPauseMinutes", env.CODEX_QUOTA_DEMO_PAUSE_MINUTES, (value) => { config.demoPauseMinutes = value; });
  return { config, locked };
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

function boolFromEnv(value: string): boolean {
  if (["1", "true", "on", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "off", "no"].includes(value.toLowerCase())) return false;
  throw new Error(`Invalid boolean environment value '${value}'.`);
}
