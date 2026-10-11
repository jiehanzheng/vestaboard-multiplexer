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

export const HABlockInstanceSchema = HABlockConfigSchema.safeExtend({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, "Use a stable block ID containing letters, digits, hyphens, or underscores."),
  name: z.string().trim().min(1).max(64)
});
export type HABlockInstance = z.infer<typeof HABlockInstanceSchema>;
export const HABlocksSchema = z.array(HABlockInstanceSchema).superRefine((blocks, context) => {
  const ids = new Set<string>();
  blocks.forEach((block, index) => {
    if (ids.has(block.id)) context.addIssue({ code: "custom", path: [index, "id"], message: "Block IDs must be unique." });
    ids.add(block.id);
  });
});
export function haBlockElementId(id: string): string { return `ha-block.${id}`; }

/** Keep the legacy element ID so deployed layouts continue to point to the migrated block. */
export function legacyHABlock(config: HABlockConfig): HABlockInstance {
  return { ...config, id: "characters", name: "HA character block" };
}

export function mergeHABlocks(base: HABlockInstance[], blocks?: HABlockInstance[], legacy?: Partial<HABlockConfig>): HABlockInstance[] {
  if (blocks !== undefined && legacy !== undefined) throw new Error("Use haBlocks or legacy haBlock, not both.");
  if (blocks !== undefined) return blocks;
  if (legacy === undefined) return base;
  const existing = base.find((block) => block.id === "characters");
  const updated = { ...(existing ?? legacyHABlock(DEFAULT_HA_BLOCK_CONFIG)), ...legacy };
  return existing ? base.map((block) => block.id === "characters" ? updated : block) : [...base, updated];
}

export function normalizeLegacyHABlocks(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (!("haBlock" in record)) return value;
  if (record.haBlocks !== undefined) throw new Error("Saved config contains both haBlock and haBlocks.");
  const { haBlock, ...rest } = record;
  return { ...rest, haBlocks: [haBlock && typeof haBlock === "object" && !Array.isArray(haBlock)
    ? { ...haBlock, id: "characters", name: "HA character block" } : haBlock] };
}
