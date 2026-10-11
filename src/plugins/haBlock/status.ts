import { ELEMENT_STATES } from "../../contracts/layout.js";
import { z } from "zod";

export const HABlockStatusSchema = z.object({
  state: z.enum(ELEMENT_STATES).optional(), textTruncated: z.boolean().optional(),
  enabled: z.boolean(), error: z.string().optional(), unavailableSince: z.string().optional(), stale: z.boolean()
}).strict();
export type HABlockStatus = z.infer<typeof HABlockStatusSchema>;
