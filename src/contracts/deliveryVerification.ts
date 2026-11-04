import { z } from "zod";

export const DeliveryVerificationSchema = z.object({
  state: z.enum(["pending", "matched", "mismatch", "unverified"]),
  source: z.enum(["local", "cloud"]).optional(),
  checkedAt: z.number().optional(),
  nextCheckAt: z.number().optional(),
  correctionUsed: z.boolean(),
  error: z.string().optional()
}).strict();
export type DeliveryVerification = z.infer<typeof DeliveryVerificationSchema>;
