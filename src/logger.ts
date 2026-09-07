import { z } from "zod";

export const LogEntrySchema = z.object({
  timestamp: z.string(),
  level: z.enum(["info", "warn", "error"]),
  source: z.string().min(1),
  message: z.string().max(2048)
}).strict();

export const LogsResponseSchema = z.object({ entries: z.array(LogEntrySchema).max(200) }).strict();

export type LogEntry = z.infer<typeof LogEntrySchema>;
export type LogsResponse = z.infer<typeof LogsResponseSchema>;
export type LogLevel = LogEntry["level"];
export type ConsoleSink = Pick<Console, "info" | "warn" | "error">;

export interface Logger {
  info(message: unknown): void;
  warn(message: unknown): void;
  error(message: unknown): void;
}

/** Bounded in-memory diagnostics; Docker remains the durable log owner. */
export class LogBuffer {
  private readonly entries: LogEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private secrets: string[] = [];

  constructor(private readonly sink: ConsoleSink = console, private readonly now: () => Date = () => new Date()) {}

  setSecrets(values: readonly unknown[]): void {
    this.secrets = [...new Set(values.filter((value): value is string => typeof value === "string" && value.length >= 3))]
      .sort((left, right) => right.length - left.length);
  }

  child(source: string): Logger {
    return {
      info: (message) => this.write("info", source, message),
      warn: (message) => this.write("warn", source, message),
      error: (message) => this.write("error", source, message)
    };
  }

  write(level: LogLevel, source: string, message: unknown): void {
    const safeMessage = truncateMessage(redact(formatMessage(message), this.secrets));
    const entry = LogEntrySchema.parse({ timestamp: this.now().toISOString(), level, source, message: safeMessage });
    this.entries.push(entry);
    if (this.entries.length > 200) this.entries.splice(0, this.entries.length - 200);
    this.sink[level](`[${source}] ${safeMessage}`);
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
  if (message.length <= 2048) return message;
  let result = message.slice(0, 2048);
  while (result && new TextEncoder().encode(result).byteLength > 2048) result = result.slice(0, -1);
  return result;
}
