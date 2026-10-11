import { gradualStatus, UpdateLimitsSchema, type UpdateLimit, type UpdateLimitStatus } from "../contracts/updateLimits.js";

interface Usage { rule: UpdateLimit; attempts: number[]; fullAt: number; at: number }

/** Each rule owns usage so unrelated saves and unchanged stable IDs preserve it. */
export class AutomaticUpdateLimits {
  private rules: Usage[] = [];
  constructor(rules: UpdateLimit[], now: number) { this.configure(rules, now); }

  configure(rules: UpdateLimit[], now: number): void {
    const validated = UpdateLimitsSchema.parse(rules);
    this.rules = validated.map((rule) => {
      const previous = this.rules.find((value) => value.rule.id === rule.id);
      return previous && previous.rule.mode === rule.mode && previous.rule.maxUpdates === rule.maxUpdates && previous.rule.windowMinutes === rule.windowMinutes
        ? previous : { rule, attempts: [], fullAt: now, at: now };
    });
  }

  status(now: number): UpdateLimitStatus[] {
    return this.rules.map((usage) => {
      const { rule } = usage;
      const windowMs = rule.windowMinutes * 60_000;
      const time = Math.max(now, usage.at);
      if (rule.mode === "rolling") {
        usage.attempts = usage.attempts.filter((at) => at + windowMs > time);
        usage.at = time;
        const used = usage.attempts.length;
        return { ...rule, used, remaining: Math.max(0, rule.maxUpdates - used), blocked: used >= rule.maxUpdates,
          nextSlotAt: used ? usage.attempts[Math.max(0, used - rule.maxUpdates)]! + windowMs : undefined,
          observedAt: time, attempts: [...usage.attempts] };
      }
      usage.at = time;
      return gradualStatus(rule, usage.fullAt, time);
    });
  }

  nextEligibleAt(now: number): number | undefined {
    const blocked = this.status(now).filter((rule) => rule.blocked);
    return blocked.length ? blocked.reduce((latest, rule) => Math.max(latest, rule.nextSlotAt!), 0) : undefined;
  }

  reserve(now: number): void {
    this.status(now);
    for (const usage of this.rules) {
      if (usage.rule.mode === "rolling") usage.attempts.push(Math.max(now, usage.at));
      else usage.fullAt = Math.max(usage.fullAt, usage.at) + usage.rule.windowMinutes * 60_000 / usage.rule.maxUpdates;
    }
  }
}
