import { z } from "zod";
export const BarRowFields = ["displayName", "current", "max", "displayText"] as const;
export type BarRowField = typeof BarRowFields[number];
const input = z.object({ configured: z.boolean(), value: z.union([z.string(), z.number().finite()]).optional(), error: z.string().optional() }).strict();
export const BarRowStatusSchema = z.object({ state: z.enum(["active", "inactive", "unavailable"]), enabled: z.boolean(), inputs: z.object({ displayName: input, current: input, max: input, displayText: input }).strict(),
  error: z.string().optional(), unavailableSince: z.string().optional(), stale: z.boolean() }).strict();
export type BarRowStatus = z.infer<typeof BarRowStatusSchema>;
export const BarRowsStatusSchema = z.record(z.string(), BarRowStatusSchema);
