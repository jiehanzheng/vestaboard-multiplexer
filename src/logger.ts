import { LogEntrySchema, LogsResponseSchema, type LogEntry, type LogLevel, type LogsResponse } from "./contracts/logs.js";
export { LogEntrySchema, LogsResponseSchema } from "./contracts/logs.js";
export type { LogEntry, LogLevel, LogsResponse } from "./contracts/logs.js";
export type ConsoleSink = Pick<Console, "info" | "warn" | "error">;

export interface Logger {
  info(message: unknown, ...details: unknown[]): void;
  warn(message: unknown, ...details: unknown[]): void;
  error(message: unknown, ...details: unknown[]): void;
}

/** Bounded in-memory diagnostics; Docker remains the durable log owner. */
export class LogBuffer {
  private readonly entries: LogEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private secrets: string[] = [];

  constructor(private readonly sink: ConsoleSink = console, private readonly now: () => Date = () => new Date()) {}

  setSecrets(values: readonly unknown[]): void {
    this.secrets = [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))]
      .sort((left, right) => right.length - left.length);
  }

  child(source: string): Logger {
    return {
      info: (message, ...details) => this.write("info", source, [message, ...details]),
      warn: (message, ...details) => this.write("warn", source, [message, ...details]),
      error: (message, ...details) => this.write("error", source, [message, ...details])
    };
  }

  write(level: LogLevel, source: string, message: unknown | readonly unknown[]): void {
    const values = Array.isArray(message) ? message : [message];
    const safeMessage = truncateMessage(redact(values.map(formatMessage).join(" "), this.secrets));
    const entry = LogEntrySchema.parse({ timestamp: this.now().toISOString(), level, source, message: safeMessage });
    this.entries.push(entry);
    if (this.entries.length > 200) this.entries.splice(0, this.entries.length - 200);
    try { this.sink[level](`${entry.timestamp} ${entry.level} [${source}] ${safeMessage}`); }
    catch { /* console sinks are observational and cannot break runtime work */ }
    for (const listener of this.listeners) {
      try { listener(); } catch { /* log observers cannot break the runtime */ }
    }
  }

  snapshot(): LogsResponse {
    return LogsResponseSchema.parse({ entries: this.entries.map((entry) => ({ ...entry })) });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function redact(message: string, secrets: readonly string[]): string {
  return secrets.reduce((result, secret) => result.split(secret).join("[REDACTED]"), message);
}

function formatMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof Error) return message.message;
  try { return JSON.stringify(message) ?? String(message); }
  catch { return String(message); }
}

function truncateMessage(message: string): string {
  let result = message.slice(0, 2048);
  while (result && new TextEncoder().encode(result).byteLength > 2048) result = result.slice(0, -1);
  return result;
}
