import { z } from "zod";
import { BLUE, isValidCharacterCode } from "../../vestaboardCharacters.js";

export const BarRowEntityInputSchema = z.object({ kind: z.literal("entity"), entityId: z.string().trim().min(1), attribute: z.string().trim().min(1).optional() }).strict();
export const BarRowNumberInputSchema = z.union([z.object({ kind: z.literal("constant"), value: z.number().finite() }).strict(), BarRowEntityInputSchema]);
export const BarRowTextInputSchema = z.union([z.object({ kind: z.literal("constant"), value: z.string() }).strict(), BarRowEntityInputSchema]);
export const BarRowSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entity"), entityId: z.string().trim(), attributes: z.object({
    displayName: z.string().trim().min(1).default("display_name"), current: z.string().trim().min(1).default("current"),
    max: z.string().trim().min(1).default("max"), displayText: z.string().trim().min(1).default("display_text")
  }).strict().default({ displayName: "display_name", current: "current", max: "max", displayText: "display_text" }) }).strict(),
  z.object({ kind: z.literal("fields"), displayName: BarRowTextInputSchema, current: BarRowNumberInputSchema,
    max: BarRowNumberInputSchema, displayText: BarRowTextInputSchema }).strict()
]);
export const BarRowConfigSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]+$/, "Use a stable row ID containing letters, digits, hyphens, or underscores."),
  name: z.string().trim().min(1).max(64), enabled: z.boolean(), source: BarRowSourceSchema,
  labelWidth: z.number().int().min(0).max(21).default(2), textWidth: z.number().int().min(0).max(21).default(3),
  barCharacter: z.number().int().refine(isValidCharacterCode, "must be a valid Vestaboard character code").default(BLUE),
  unavailableDisplay: z.enum(["na", "blank"]).default("na"), staleAfterMinutes: z.number().finite().positive().nullable().default(15)
}).strict().superRefine((value, context) => {
  if (value.enabled && value.source.kind === "entity" && !value.source.entityId) context.addIssue({ code: "custom", path: ["source", "entityId"], message: "Select a Home Assistant entity." });
  if (value.labelWidth + value.textWidth + 1 > 22) context.addIssue({ code: "custom", path: ["textWidth"], message: "Label, text and at least one bar cell must fit within 22 columns." });
});
export const BarRowsSchema = z.array(BarRowConfigSchema).superRefine((rows, context) => {
  const ids = new Set<string>();
  rows.forEach((row, index) => {
    if (ids.has(row.id)) context.addIssue({ code: "custom", path: [index, "id"], message: "Row IDs must be unique." });
    ids.add(row.id);
  });
});
export type BarRowConfig = z.infer<typeof BarRowConfigSchema>;
export type BarRowSource = z.infer<typeof BarRowSourceSchema>;
export type BarRowInput = z.infer<typeof BarRowNumberInputSchema> | z.infer<typeof BarRowTextInputSchema>;
export function barRowElementId(id: string): string { return `bar-row.${id}`; }
export function barRowGeometry(config: BarRowConfig) { return { height: 1, minWidth: Math.max(config.labelWidth + config.textWidth + 1, config.unavailableDisplay === "na" ? 3 : 1) }; }

export const DEFAULT_BAR_ROW_CONFIG = { enabled: false, source: { kind: "entity" as const, entityId: "", attributes: { displayName: "display_name", current: "current", max: "max", displayText: "display_text" } }, labelWidth: 2, textWidth: 3, barCharacter: BLUE, unavailableDisplay: "na" as const, staleAfterMinutes: 15 };
