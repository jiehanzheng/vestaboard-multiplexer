import { z } from "zod";

export const UpdateLimitSchema = z.object({
  id: z.string().trim().min(1),
  mode: z.enum(["rolling", "gradual"]).default("rolling"),
  maxUpdates: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  windowMinutes: z.number().finite().positive().refine((value) => value * 60_000 >= 1 && value * 60_000 <= Number.MAX_SAFE_INTEGER, "Period must be between one millisecond and the maximum safe duration.")
}).strict();
export const UpdateLimitsSchema = z.array(UpdateLimitSchema).min(1).superRefine((rules, context) => {
  const ids = new Set<string>();
  rules.forEach((rule, index) => {
    if (ids.has(rule.id)) context.addIssue({ code: "custom", path: [index, "id"], message: "Limit IDs must be unique." });
    ids.add(rule.id);
  });
});
export type UpdateLimit = z.infer<typeof UpdateLimitSchema>;
export const UpdateLimitStatusSchema = UpdateLimitSchema.extend({
  remaining: z.number().int().nonnegative(),
  used: z.number().finite().nonnegative(),
  blocked: z.boolean(),
  nextSlotAt: z.number().optional(),
  // Absolute credit/time anchors let clients update counters without SSE heartbeats.
  credits: z.number().finite().optional(),
  refillFullAt: z.number().finite().optional(),
  observedAt: z.number(),
  attempts: z.array(z.number()).optional()
}).strict();
export type UpdateLimitStatus = z.infer<typeof UpdateLimitStatusSchema>;
export function intervalLimit(minutes: number): UpdateLimit[] {
  return [{ id: "legacy-interval", mode: "rolling", maxUpdates: 1, windowMinutes: minutes }];
}

/** Project saved counters locally; reads never change the server's usage. */
export function projectUpdateLimit(status: UpdateLimitStatus, now: number): UpdateLimitStatus {
  const time = Math.max(now, status.observedAt);
  const windowMs = status.windowMinutes * 60_000;
  if (status.mode === "rolling") {
    const attempts = (status.attempts ?? []).filter((at) => at + windowMs > time);
    const used = attempts.length;
    return { ...status, attempts, used, remaining: Math.max(0, status.maxUpdates - used), blocked: used >= status.maxUpdates,
      nextSlotAt: used ? attempts[Math.max(0, used - status.maxUpdates)]! + windowMs : undefined, observedAt: time };
  }
  return gradualStatus(status, status.refillFullAt ?? status.observedAt, time);
}

/** Absolute refill time avoids accumulating rounding error as status is read. */
export function gradualStatus(rule: UpdateLimit, fullAt: number, time: number): UpdateLimitStatus {
  const unitMs = rule.windowMinutes * 60_000 / rule.maxUpdates;
  const credits = Math.min(rule.maxUpdates, rule.maxUpdates - Math.max(0, fullAt - time) / unitMs);
  const readyAt = Math.ceil(fullAt - (rule.maxUpdates - 1) * unitMs);
  const blocked = time < readyAt;
  const remaining = blocked ? 0 : Math.max(1, Math.floor(credits));
  const target = Math.max(1, remaining + 1);
  return { ...rule, credits, refillFullAt: fullAt, used: Math.max(0, rule.maxUpdates - credits), remaining, blocked,
    nextSlotAt: remaining < rule.maxUpdates ? Math.ceil(fullAt - (rule.maxUpdates - target) * unitMs) : undefined,
    observedAt: time };
}
