import { z } from "zod";
import { BLUE, HEART, charCode, isValidCharacterCode } from "../../vestaboardCharacters.js";

const finiteNumber = z.number().finite();
const characterCode = z.number().int().refine(isValidCharacterCode, "must be a valid Vestaboard character code");
const displayLabel = z.string()
  .refine((value) => {
    const length = [...value].length;
    return length >= 1 && length <= 2;
  }, "must be 1 or 2 characters")
  .refine((value) => value === value.toUpperCase(), "must use uppercase characters")
  .refine((value) => {
    try {
      for (const character of value) charCode(character);
      return true;
    } catch {
      return false;
    }
  }, "must use supported Vestaboard characters");

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

const waterHeaterConfigShape = {
  remaining: InputSchema,
  capacity: InputSchema,
  temperature: InputSchema,
  target: InputSchema,
  emvPosition: InputSchema.optional(),
  heating: HeatingInputSchema.optional(),
  emvProblem: z.preprocess((value) => {
    // Earlier deployments saved modes; normalize them without changing the active condition.
    if (value && typeof value === "object" && !("equals" in value) && "mode" in value) {
      const { mode, ...binding } = value;
      if (mode === "binary" || mode === "missed-flow-off") return { ...binding, equals: mode === "binary" ? "on" : "Missed flow off active" };
    }
    return value;
  }, EntityInputSchema.extend({ equals: z.string() })).nullable().optional(),
  heatingCharacter: characterCode,
  barCharacter: characterCode,
  remainingLabel: displayLabel,
  emvLabel: displayLabel,
  unit: z.enum(["F", "C"]),
  enabled: z.boolean()
};

export const WaterHeaterConfigBaseSchema = z.object({
  ...waterHeaterConfigShape,
  heatingCharacter: characterCode.default(HEART),
  barCharacter: characterCode.default(BLUE),
  remainingLabel: displayLabel.default("HW"),
  emvLabel: displayLabel.default("MV")
}).strict();

/** Patch fields stay optional so omitted character settings cannot reset saved values. */
export const WaterHeaterConfigPatchSchema = z.object(waterHeaterConfigShape).partial().strict();

export const WaterHeaterConfigSchema = WaterHeaterConfigBaseSchema.superRefine((config, context) => {
  if (config.remaining && "constant" in config.remaining && config.remaining.constant < 0) {
    context.addIssue({ code: "custom", path: ["remaining", "constant"], message: "must be non-negative" });
  }
  if (config.capacity && "constant" in config.capacity && config.capacity.constant <= 0) {
    context.addIssue({ code: "custom", path: ["capacity", "constant"], message: "must be positive" });
  }
});

export type WaterHeaterConfig = z.infer<typeof WaterHeaterConfigSchema>;
export type WaterHeaterConfigPatch = z.infer<typeof WaterHeaterConfigPatchSchema>;

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
  heatingCharacter: HEART,
  barCharacter: BLUE,
  remainingLabel: "HW",
  emvLabel: "MV",
  unit: "F",
  enabled: false
};

export function validateWaterHeaterConfig(value: unknown): string[] {
  const result = WaterHeaterConfigSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".") || "water"} ${issue.message}`);
}
