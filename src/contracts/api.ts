import { z } from "zod";
import { LayoutEntrySchema, PublicConfigSchema } from "./config.js";
import { CodexConfigSchema } from "../plugins/codexQuota/config.js";
import { HAStatusSchema, HAEntitySchema } from "./homeAssistant.js";
import { WaterHeaterConfigSchema } from "../plugins/waterHeater/config.js";
import { WaterHeaterStatusSchema } from "../plugins/waterHeater/status.js";
import { isValidCharacterCode } from "../vestaboardCharacters.js";
export { LogEntrySchema, LogsResponseSchema } from "./logs.js";
export type { LogEntry, LogsResponse } from "./logs.js";

const cell = z.number().refine(isValidCharacterCode, "must be a valid Vestaboard character code");

export const BoardMessageSchema = z.object({
  text: z.string(),
  characters: z.array(z.array(cell)).optional()
}).strict();

export type BoardMessage = z.infer<typeof BoardMessageSchema>;

export const BoardElementSchema = z.object({
  id: z.string().min(1),
  label: z.string(),
  height: z.number().int().positive(),
  minWidth: z.number().int().positive().optional(),
  preview: z.array(z.array(cell))
}).strict();

export const ElementsResponseSchema = z.object({
  elements: z.array(BoardElementSchema),
  defaultLayout: z.array(LayoutEntrySchema).optional(),
  defaultLayouts: z.object({
    note: z.array(LayoutEntrySchema),
    flagship: z.array(LayoutEntrySchema)
  }).strict().optional()
}).strict();

export type ElementsResponse = z.infer<typeof ElementsResponseSchema>;

export const PreviewRequestSchema = z.object({
  layout: z.array(LayoutEntrySchema),
  board: z.enum(["auto", "note", "flagship"]).optional(),
  water: WaterHeaterConfigSchema.optional(),
  codex: CodexConfigSchema.optional()
}).strict();

export type PreviewRequest = z.infer<typeof PreviewRequestSchema>;
export const PreviewResponseSchema = z.object({
  text: z.string(),
  characters: z.array(z.array(cell))
}).strict();
export type PreviewResponse = z.infer<typeof PreviewResponseSchema>;

export const PauseRequestSchema = z.object({ paused: z.boolean() }).strict();
export type PauseRequest = z.infer<typeof PauseRequestSchema>;

export const LoginActionSchema = z.enum(["start", "cancel", "check"]);
export const LoginStatusSchema = z.object({
  pending: z.boolean(),
  account: z.string().optional(),
  error: z.string().optional(),
  userCode: z.string().optional(),
  verificationUrl: z.string().url().optional()
}).strict();
export type LoginStatus = z.infer<typeof LoginStatusSchema>;

export const RuntimeStatusSchema = z.object({
  board: z.enum(["note", "flagship"]),
  dryRun: z.boolean().optional(),
  desired: BoardMessageSchema.optional(),
  lastSent: BoardMessageSchema.optional(),
  nextAttemptAt: z.number(),
  lastSentAt: z.number().optional(),
  manualPause: z.boolean(),
  haPause: z.boolean(),
  paused: z.boolean(),
  pauseReason: z.string().optional(),
  persistenceError: z.string().optional(),
  deliveryError: z.string().optional(),
  configError: z.string().optional(),
  codex: z.object({ error: z.string().optional(), collectedAt: z.string().optional() }).strict(),
  homeAssistant: HAStatusSchema.optional(),
  water: WaterHeaterStatusSchema.optional(),
  login: LoginStatusSchema
}).strict();

export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;
export const RuntimeEventSchema = RuntimeStatusSchema;
export type RuntimeEvent = RuntimeStatus;

export const ErrorResponseSchema = z.object({ error: z.string() }).strict();
export const ConfigResponseSchema = PublicConfigSchema;

export { HAEntitySchema };
