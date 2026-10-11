import { z } from "zod";

export const HABlockStatusSchema = z.object({
  enabled: z.boolean(), error: z.string().optional(), unavailableSince: z.string().optional(), stale: z.boolean()
}).strict();
export type HABlockStatus = z.infer<typeof HABlockStatusSchema>;
