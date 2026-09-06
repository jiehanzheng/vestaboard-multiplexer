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

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
