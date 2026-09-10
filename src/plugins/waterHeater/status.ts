import { z } from "zod";

export const WaterHeaterInputNames = ["remaining", "capacity", "temperature", "target", "emvPosition", "heating", "emvProblem"] as const;
export type WaterHeaterInputName = typeof WaterHeaterInputNames[number];

export const WaterHeaterInputStatusSchema = z.object({
  configured: z.boolean(),
  value: z.union([z.number().finite(), z.boolean()]).optional(),
  error: z.string().optional(),
  retained: z.boolean().optional()
}).strict();

export const WaterHeaterStatusSchema = z.object({
  enabled: z.boolean(),
  inputs: z.object({
    remaining: WaterHeaterInputStatusSchema,
    capacity: WaterHeaterInputStatusSchema,
    temperature: WaterHeaterInputStatusSchema,
    target: WaterHeaterInputStatusSchema,
    emvPosition: WaterHeaterInputStatusSchema,
    emvProblem: WaterHeaterInputStatusSchema.optional(),
    heating: WaterHeaterInputStatusSchema
  }).strict(),
  error: z.string().optional(),
  elementIssues: z.record(z.string(), z.string()).optional()
}).strict();

export type WaterHeaterInputStatus = z.infer<typeof WaterHeaterInputStatusSchema>;
export type WaterHeaterStatus = z.infer<typeof WaterHeaterStatusSchema>;

export const WATER_ELEMENT_INPUTS: Record<string, readonly WaterHeaterInputName[]> = {
  "water.remaining": ["remaining", "capacity"],
  "water.temperature-text": ["temperature", "target"],
  "water.emv-position": ["emvPosition"]
};

/** Returns the plugin-owned diagnostic for an element's required inputs. */
export function waterElementIssue(elementId: string, status: WaterHeaterStatus): string | undefined {
  if (!(elementId in WATER_ELEMENT_INPUTS)) return undefined;
  if (!status.enabled) return "Water heater is disabled.";
  if (status.elementIssues?.[elementId]) return status.elementIssues[elementId];
  if (elementId === "water.emv-position" && status.inputs.emvProblem?.value === true) return undefined;
  if (elementId === "water.emv-position" && status.inputs.emvProblem?.error) return status.inputs.emvProblem.error;
  for (const input of WATER_ELEMENT_INPUTS[elementId] ?? []) {
    const diagnostic = status.inputs[input];
    if (!diagnostic?.configured) return `${input} is not configured.`;
    if (diagnostic.error && !diagnostic.retained) return diagnostic.error;
  }
  return undefined;
}

export function emptyWaterHeaterStatus(enabled = false): WaterHeaterStatus {
  return {
    enabled,
    inputs: Object.fromEntries(WaterHeaterInputNames.map((name) => [name, { configured: false }])) as WaterHeaterStatus["inputs"]
  };
}
