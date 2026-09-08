import { z } from "zod";
import { HttpUrlSchema } from "./url.js";
import { HAConfigSchema, type HAConfig } from "./homeAssistant.js";
import { CodexConfigPatchSchema, CodexConfigSchema, type CodexConfig } from "../plugins/codexQuota/config.js";
import { WaterHeaterConfigPatchSchema, WaterHeaterConfigSchema, type WaterHeaterConfig } from "../plugins/waterHeater/config.js";
import { PauseOverlayCanvasSchema, PauseOverlaySchema, type PauseOverlay, type PauseOverlayCanvas, type PauseOverlayCell } from "./pauseOverlay.js";
export { PauseOverlayCanvasSchema, PauseOverlaySchema } from "./pauseOverlay.js";

export const LayoutEntrySchema = z.object({
  elementId: z.string().min(1),
  startRow: z.number().int().nonnegative(),
  startColumn: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional()
}).strict();

export type LayoutEntry = z.infer<typeof LayoutEntrySchema>;

export const LocalMessageTransitionSchema = z.object({
  strategy: z.enum(["column", "reverse-column", "edges-to-center", "row", "diagonal", "random"]),
  stepIntervalMs: z.number().finite().positive(),
  stepSize: z.number().finite().positive()
}).strict();

export type LocalMessageTransitionStrategy = z.infer<typeof LocalMessageTransitionSchema>["strategy"];
export type LocalMessageTransitionOptions = z.infer<typeof LocalMessageTransitionSchema>;

export type { PauseOverlay, PauseOverlayCanvas, PauseOverlayCell };

export const TransportSchema = z.object({
  token: z.string().optional(),
  localApiKey: z.string().optional(),
  cloudUrl: HttpUrlSchema,
  localUrl: HttpUrlSchema,
  localMessageTransition: LocalMessageTransitionSchema,
  /** Keep pause and resume animation together so they cannot drift into separate modes. */
  pauseMessageTransition: LocalMessageTransitionSchema.optional()
}).strict();

const appConfigShape = {
  board: z.enum(["auto", "note", "flagship"]),
  ha: HAConfigSchema,
  water: WaterHeaterConfigSchema,
  transport: TransportSchema,
  updateIntervalMinutes: z.number().finite().positive(),
  codex: CodexConfigSchema,
  layout: z.array(LayoutEntrySchema).nullable(),
  pauseOverlay: PauseOverlaySchema
};

const AppConfigBaseSchema = z.object(appConfigShape).strict();
export const AppConfigSchema = AppConfigBaseSchema;

export type AppConfig = z.infer<typeof AppConfigSchema>;

const publicTransportSchema = TransportSchema.omit({ token: true, localApiKey: true }).strip();
const publicHASchema = HAConfigSchema.omit({ token: true }).strip();
export const PublicAppConfigSchema = z.object({
  ...appConfigShape,
  ha: publicHASchema,
  transport: publicTransportSchema
}).strict();

export type PublicAppConfig = z.infer<typeof PublicAppConfigSchema>;

export const ConfigPatchSchema = z.object({
  board: z.enum(["auto", "note", "flagship"]).optional(),
  ha: HAConfigSchema.partial().nullable().optional(),
  water: WaterHeaterConfigPatchSchema.nullable().optional(),
  transport: TransportSchema.partial().extend({
    localMessageTransition: LocalMessageTransitionSchema.partial().optional(),
    pauseMessageTransition: LocalMessageTransitionSchema.partial().nullable().optional()
  }).nullable().optional(),
  updateIntervalMinutes: z.number().finite().positive().optional(),
  codex: CodexConfigPatchSchema.optional(),
  layout: z.array(LayoutEntrySchema).nullable().optional(),
  pauseOverlay: z.object({ note: PauseOverlayCanvasSchema.optional(), flagship: PauseOverlayCanvasSchema.optional() }).strict().optional()
}).strict();

export type ConfigPatch = z.infer<typeof ConfigPatchSchema>;

export const PublicConfigSchema = z.object({
  config: PublicAppConfigSchema,
  legacyEnvironmentVariables: z.array(z.string()),
  hasSecrets: z.object({
    token: z.boolean(),
    localApiKey: z.boolean(),
    haToken: z.boolean()
  }).strict(),
  error: z.string().optional()
}).strict();

export type PublicConfig = z.infer<typeof PublicConfigSchema>;

export const DeliveryOutcomeSchema = z.enum(["sent", "unchanged", "failed", "paused", "limited", "empty", "stopped"]);
export type DeliveryOutcome = z.infer<typeof DeliveryOutcomeSchema>;

export const ConfigSaveResponseSchema = PublicConfigSchema.extend({
  delivery: DeliveryOutcomeSchema
});

export type ConfigSaveResponse = z.infer<typeof ConfigSaveResponseSchema>;
export type { HAConfig, WaterHeaterConfig };
export type { CodexConfig };

export { CodexConfigPatchSchema, CodexConfigSchema, WaterHeaterConfigSchema };
