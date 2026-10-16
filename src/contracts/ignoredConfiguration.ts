import { z } from "zod";
export const IgnoredConfigurationSchema = z.object({ keys: z.array(z.string()), elementIds: z.array(z.string()) }).strict();
export type IgnoredConfiguration = z.infer<typeof IgnoredConfigurationSchema>;
