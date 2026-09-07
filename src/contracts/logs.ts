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
