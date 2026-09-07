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

export const WaterHeaterConfigBaseSchema = z.object({
  remaining: InputSchema,
  capacity: InputSchema,
  temperature: InputSchema,
  target: InputSchema,
  emvPosition: InputSchema.optional(),
  unit: z.enum(["F", "C"]),
  baseline: finiteNumber.optional(),
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

export function waterHeaterLayoutIssues(
  config: WaterHeaterConfig,
  layout: readonly { elementId: string }[] | null
): Array<{ path: string[]; message: string }> {
  if (config.enabled && layout?.some((entry) => entry.elementId === "water.temperature-bar") && config.baseline === undefined) {
    return [{ path: ["water", "baseline"], message: "is required when water.temperature-bar is allocated" }];
  }
  return [];
}

export const DEFAULT_WATER_HEATER_CONFIG: WaterHeaterConfig = {
  remaining: null,
  capacity: null,
  temperature: null,
  target: null,
  emvPosition: null,
  unit: "F",
  enabled: false
};

export function validateWaterHeaterConfig(value: unknown): string[] {
  const result = WaterHeaterConfigSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".") || "water"} ${issue.message}`);
}
