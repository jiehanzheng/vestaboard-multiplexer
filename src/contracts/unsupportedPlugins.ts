import { z } from "zod";

export const IgnoredPluginSchema = z.object({ id: z.literal("water"), settingsPresent: z.boolean(), elementIds: z.array(z.string()) }).strict();
export type IgnoredPlugin = z.infer<typeof IgnoredPluginSchema>;

// Retirement is explicit: unknown keys still fail validation instead of being silently hidden.
export const RETIRED_PLUGINS = [{ id: "water", settingsKey: "water", elementPrefix: "water." }] as const;
