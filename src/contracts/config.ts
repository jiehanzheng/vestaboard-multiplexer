import { z } from "zod";
import { HAConfigSchema, type HAConfig } from "./homeAssistant.js";
import { CodexConfigSchema, type CodexConfig } from "../plugins/codexQuota/config.js";
import { WaterHeaterConfigBaseSchema, WaterHeaterConfigSchema, type WaterHeaterConfig, waterHeaterLayoutIssues } from "../plugins/waterHeater/config.js";

export const LayoutEntrySchema = z.object({
  elementId: z.string().min(1),
  startRow: z.number().int().nonnegative()
}).strict();

export type LayoutEntry = z.infer<typeof LayoutEntrySchema>;

export const LocalMessageTransitionSchema = z.object({
  strategy: z.enum(["column", "reverse-column", "edges-to-center", "row", "diagonal", "random"]),
  stepIntervalMs: z.number().finite().positive(),
  stepSize: z.number().finite().positive()
}).strict();

export type LocalMessageTransitionStrategy = z.infer<typeof LocalMessageTransitionSchema>["strategy"];
export type LocalMessageTransitionOptions = z.infer<typeof LocalMessageTransitionSchema>;

const transportSchema = z.object({
  token: z.string().optional(),
  localApiKey: z.string().optional(),
  cloudUrl: z.string().min(1),
  localUrl: z.string().min(1),
  localMessageTransition: LocalMessageTransitionSchema
}).strict();

const appConfigShape = {
  board: z.enum(["auto", "note", "flagship"]),
  ha: HAConfigSchema,
  water: WaterHeaterConfigSchema,
  transport: transportSchema,
  updateIntervalMinutes: z.number().finite().positive(),
  codex: CodexConfigSchema,
  layout: z.array(LayoutEntrySchema).nullable()
};

function addAppConfigIssues(config: { water: WaterHeaterConfig; layout: LayoutEntry[] | null }, context: z.RefinementCtx): void {
  for (const issue of waterHeaterLayoutIssues(config.water, config.layout)) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
}

const AppConfigBaseSchema = z.object(appConfigShape).strict();
export const AppConfigSchema = AppConfigBaseSchema.superRefine(addAppConfigIssues);

export type AppConfig = z.infer<typeof AppConfigSchema>;

const publicTransportSchema = transportSchema.omit({ token: true, localApiKey: true }).strip();
const publicHASchema = HAConfigSchema.omit({ token: true }).strip();
export const PublicAppConfigSchema = z.object({
  ...appConfigShape,
  ha: publicHASchema,
  transport: publicTransportSchema
}).strict().superRefine(addAppConfigIssues);

export type PublicAppConfig = z.infer<typeof PublicAppConfigSchema>;

export const ConfigPatchSchema = z.object({
  board: z.enum(["auto", "note", "flagship"]).optional(),
  ha: HAConfigSchema.partial().nullable().optional(),
  water: WaterHeaterConfigBaseSchema.partial().nullable().optional(),
  transport: transportSchema.partial().extend({ localMessageTransition: LocalMessageTransitionSchema.partial().optional() }).nullable().optional(),
  updateIntervalMinutes: z.number().finite().positive().optional(),
  codex: CodexConfigSchema.partial().optional(),
  layout: z.array(LayoutEntrySchema).nullable().optional()
}).strict();

export type ConfigPatch = z.infer<typeof ConfigPatchSchema>;

export const PublicConfigSchema = z.object({
  config: PublicAppConfigSchema,
  locked: z.array(z.string()),
  hasSecrets: z.object({
    token: z.boolean(),
    localApiKey: z.boolean(),
    haToken: z.boolean()
  }).strict(),
  error: z.string().optional()
}).strict();

export type PublicConfig = z.infer<typeof PublicConfigSchema>;
export type { HAConfig, WaterHeaterConfig };
export type { CodexConfig };

export { CodexConfigSchema, WaterHeaterConfigSchema };
