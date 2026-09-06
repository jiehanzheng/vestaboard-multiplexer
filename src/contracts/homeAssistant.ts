import { z } from "zod";
import { HttpUrlSchema } from "./url.js";

const httpUrl = z.union([z.literal(""), HttpUrlSchema]);

const pauseBinding = z.object({
  entityId: z.string().refine((value) => value.trim().length > 0, "is required"),
  pauseValue: z.string().refine((value) => value.trim().length > 0, "is required"),
  resumeValue: z.string().refine((value) => value.trim().length > 0, "is required")
}).strict().superRefine((value, context) => {
  if (value.pauseValue === value.resumeValue) {
    context.addIssue({ code: "custom", path: ["resumeValue"], message: "must differ from pauseValue" });
  }
});

export const HAConfigSchema = z.object({
  url: httpUrl,
  token: z.string().optional(),
  pause: pauseBinding.nullable()
}).strict();

export type HAConfig = z.infer<typeof HAConfigSchema>;

export const HAEntitySchema = z.object({
  entity_id: z.string().min(1),
  state: z.string(),
  attributes: z.record(z.string(), z.unknown()),
  last_updated: z.string().optional()
}).strict();

export type HAEntity = z.infer<typeof HAEntitySchema>;

export const HAStatusSchema = z.object({
  connected: z.boolean(),
  error: z.string().optional()
}).strict();

export type HAStatus = z.infer<typeof HAStatusSchema>;

export const HAConnectionTestRequestSchema = z.object({
  url: httpUrl.optional(),
  token: z.string().optional()
}).strict();

export type HAConnectionTestRequest = z.infer<typeof HAConnectionTestRequestSchema>;

export const HAConnectionTestResponseSchema = HAStatusSchema;
export type HAConnectionTestResponse = z.infer<typeof HAConnectionTestResponseSchema>;

export const HAEntitiesRequestSchema = HAConnectionTestRequestSchema;
export type HAEntitiesRequest = z.infer<typeof HAEntitiesRequestSchema>;

export const HAEntitiesResponseSchema = z.object({
  entities: z.array(HAEntitySchema)
}).strict();

export type HAEntitiesResponse = z.infer<typeof HAEntitiesResponseSchema>;
