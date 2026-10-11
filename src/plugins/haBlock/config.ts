import { z } from "zod";

const shape = {
  enabled: z.boolean(),
  entityId: z.string(),
  attribute: z.string().trim().min(1),
  width: z.number().int().min(1).max(22),
  height: z.number().int().min(1).max(6),
  unavailableDisplay: z.enum(["blank", "na"]),
  staleAfterMinutes: z.number().finite().positive().nullable()
};

export const DEFAULT_HA_BLOCK_CONFIG = {
  enabled: false, entityId: "", attribute: "characters", width: 3, height: 1,
  unavailableDisplay: "na" as const, staleAfterMinutes: 15
};

export const HABlockConfigSchema = z.object(shape).strict().superRefine((value, context) => {
  if (value.enabled && !value.entityId.trim()) {
    context.addIssue({ code: "custom", path: ["entityId"], message: "Select a Home Assistant entity." });
  }
  if (value.unavailableDisplay === "na" && value.width < 3) {
    context.addIssue({ code: "custom", path: ["unavailableDisplay"], message: "N/A needs at least three columns." });
  }
});
export const HABlockConfigPatchSchema = z.object(shape).partial().strict();
export type HABlockConfig = z.infer<typeof HABlockConfigSchema>;

export const HA_BLOCK_ELEMENT_ID = "ha-block.characters";
export function haBlockGeometry(config: HABlockConfig) {
  return { height: config.height, minWidth: config.width };
}
