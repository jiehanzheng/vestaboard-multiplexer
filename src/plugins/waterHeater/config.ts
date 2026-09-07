import { z } from "zod";

const finiteNumber = z.number().finite();

export const ConstantInputSchema = z.object({ constant: finiteNumber }).strict();
export const EntityInputSchema = z.object({
  entityId: z.string().refine((value) => value.trim().length > 0, "is required"),
  attribute: z.string().refine((value) => value.trim().length > 0, "must be a non-empty string").optional()
}).strict();
export const InputSchema = z.union([ConstantInputSchema, EntityInputSchema]).nullable();

export type ConstantInput = z.infer<typeof ConstantInputSchema>;
export type EntityInput = z.infer<typeof EntityInputSchema>;
export type Input = z.infer<typeof InputSchema>;
export const HeatingInputSchema = EntityInputSchema.nullable();
export type HeatingInput = z.infer<typeof HeatingInputSchema>;

export const WaterHeaterConfigBaseSchema = z.object({
  remaining: InputSchema,
  capacity: InputSchema,
  temperature: InputSchema,
  target: InputSchema,
  emvPosition: InputSchema.optional(),
  heating: HeatingInputSchema.optional(),
  unit: z.enum(["F", "C"]),
  enabled: z.boolean()
}).strict();

export const WaterHeaterConfigSchema = WaterHeaterConfigBaseSchema.superRefine((config, context) => {
  if (config.remaining && "constant" in config.remaining && config.remaining.constant < 0) {
    context.addIssue({ code: "custom", path: ["remaining", "constant"], message: "must be non-negative" });
  }
  if (config.capacity && "constant" in config.capacity && config.capacity.constant <= 0) {
    context.addIssue({ code: "custom", path: ["capacity", "constant"], message: "must be positive" });
  }
});

export type WaterHeaterConfig = z.infer<typeof WaterHeaterConfigSchema>;

/** Accept version-1 files from before the temperature bar was retired. */
export function normalizeLegacyWaterHeaterConfig(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const water = record.water;
  const normalizedWater = water && typeof water === "object" && !Array.isArray(water)
    ? Object.fromEntries(Object.entries(water).filter(([key]) => key !== "baseline"))
    : water;
  const layout = Array.isArray(record.layout)
    ? record.layout.filter((entry) => !(entry && typeof entry === "object" && !Array.isArray(entry) && (entry as { elementId?: unknown }).elementId === "water.temperature-bar"))
    : record.layout;
  return { ...record, water: normalizedWater, layout };
}

export const DEFAULT_WATER_HEATER_CONFIG: WaterHeaterConfig = {
  remaining: null,
  capacity: null,
  temperature: null,
  target: null,
  emvPosition: null,
  heating: null,
  unit: "F",
  enabled: false
};

export function validateWaterHeaterConfig(value: unknown): string[] {
  const result = WaterHeaterConfigSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".") || "water"} ${issue.message}`);
}
