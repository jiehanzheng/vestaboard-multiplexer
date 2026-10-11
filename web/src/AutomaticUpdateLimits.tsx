import { useEffect, useState, type ReactNode } from "react";
import { UpdateLimitsSchema, projectUpdateLimit, type UpdateLimit, type UpdateLimitStatus } from "../../src/contracts/updateLimits.js";

function useClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
function countdown(at: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
function ruleName(rule: UpdateLimit): string {
  return `${rule.maxUpdates} per ${rule.windowMinutes} min · ${rule.mode === "rolling" ? "Rolling window" : "Gradual refill"}`;
}
export function limitsError(rules: UpdateLimit[]): string | undefined {
  const result = UpdateLimitsSchema.safeParse(rules);
  return result.success ? undefined : result.error.issues[0]?.message;
}

function Capacity({ value, now, index }: { value: UpdateLimitStatus; now: number; index: number }): ReactNode {
  return <div className={`limit-capacity${value.blocked ? " exhausted" : ""}`}>
    <div className="limit-capacity-heading"><strong>{value.remaining} of {value.maxUpdates} available</strong><span>{value.blocked ? "Limiting updates" : "Available"}</span></div>
    <progress aria-label={`Saved limit ${index + 1} available capacity`} value={value.remaining} max={value.maxUpdates} />
    <small>{ruleName(value)} · {Number(value.used.toFixed(2))} used{value.credits !== undefined && value.credits < 0 ? " (settings-save debt)" : ""}</small>
    <small>{value.nextSlotAt ? `Next slot in ${countdown(value.nextSlotAt, now)} · ${new Date(value.nextSlotAt).toLocaleTimeString()}` : "Full capacity"}</small>
  </div>;
}

export function AutomaticUpdateLimitsSettings({ rules, saved, live, onChange }: { rules: UpdateLimit[]; saved: UpdateLimit[] | undefined; live: UpdateLimitStatus[] | undefined; onChange: (rules: UpdateLimit[]) => void }): ReactNode {
  const now = useClock();
  const error = limitsError(rules);
  const changed = JSON.stringify(rules) !== JSON.stringify(saved);
  const update = (index: number, patch: Partial<UpdateLimit>): void => onChange(rules.map((rule, at) => at === index ? { ...rule, ...patch } : rule));
  return <section className="automatic-limits" aria-labelledby="automatic-limits-heading">
    <div className="section-heading"><div><h3 id="automatic-limits-heading">Automatic update limits</h3><p>Every rule must have capacity before an automatic board update.</p></div></div>
    <div className="limit-rules">{rules.map((rule, index) => <fieldset className="limit-rule" key={rule.id}>
      <legend>Limit {index + 1}</legend>
      <label className="config-field"><span>Mode</span><select aria-label={`Limit ${index + 1} mode`} value={rule.mode} onChange={(event) => update(index, { mode: event.target.value as UpdateLimit["mode"] })}><option value="rolling">Rolling window</option><option value="gradual">Gradual refill</option></select></label>
      <div className="limit-numbers"><label className="config-field"><span>Up to</span><input aria-label={`Limit ${index + 1} updates`} type="number" min={1} step={1} value={rule.maxUpdates} onChange={(event) => update(index, { maxUpdates: Number(event.target.value) })} /></label><span>updates per</span><label className="config-field"><span>Period</span><input aria-label={`Limit ${index + 1} minutes`} type="number" min="0.000016666666666666667" step="any" value={rule.windowMinutes} onChange={(event) => update(index, { windowMinutes: Number(event.target.value) })} /></label><span>minutes</span></div>
      <p>{rule.mode === "rolling" ? "Each attempted update occupies a slot for the whole period, then that slot becomes available." : "Credits refill continuously at this rate, up to the rule’s capacity. Each attempted update spends one credit."}</p>
      <button type="button" className="button quiet" aria-label={`Remove limit ${index + 1}`} disabled={rules.length === 1} onClick={() => onChange(rules.filter((_, at) => at !== index))}>Remove limit</button>
    </fieldset>)}</div>
    <button type="button" className="button quiet" onClick={() => onChange([...rules, { id: crypto.randomUUID(), mode: "rolling", maxUpdates: 1, windowMinutes: 1 }])}>Add limit</button>
    {error ? <p className="inline-message error" role="alert">{error}</p> : null}
    <p className="screen-footnote">Settings saves bypass these limits but consume capacity, including on failure. Startup banners are excluded. Usage resets when the app restarts. New or changed rules start fresh when saved; unchanged rules keep their usage.</p>
    <div className="saved-limit-capacity"><h4>Saved rules · live capacity</h4>{changed ? <p className="screen-footnote">These counters describe the saved rules. Your edits take effect only after Save board settings; Discard restores the saved rules.</p> : null}<div className="limit-capacity-grid">{live?.map((value, index) => <Capacity key={value.id} value={projectUpdateLimit(value, now)} now={now} index={index} />) ?? <p>Waiting for live capacity…</p>}</div></div>
  </section>;
}

export function AutomaticUpdateCapacity({ live, pending, nextAttemptAt, held }: { live: UpdateLimitStatus[] | undefined; pending: boolean | undefined; nextAttemptAt: number | undefined; held: boolean }): ReactNode {
  const now = useClock();
  if (!live?.length) return null;
  const rules = live.map((rule) => projectUpdateLimit(rule, now));
  const blockers = rules.filter((rule) => rule.blocked);
  const next = blockers.reduce((latest, rule) => Math.max(latest, rule.nextSlotAt ?? 0), nextAttemptAt ?? 0);
  return <section className="board-capacity" aria-label="Automatic update capacity"><div className="limit-capacity-heading"><strong>Automatic update capacity</strong><span>{held ? "Delivery held" : !pending ? "Output is current" : next > now ? `Latest update waits ${countdown(next, now)}` : "Latest update is ready"}</span></div><div className="capacity-chips">{rules.map((rule, index) => <span className={rule.blocked ? "capacity-chip exhausted" : "capacity-chip"} key={rule.id}><strong>{rule.remaining}/{rule.maxUpdates}</strong> · {rule.windowMinutes} min · {rule.mode === "rolling" ? "rolling" : "refill"}{rule.blocked ? ` · limit ${index + 1} blocking` : ""}</span>)}</div><small>Settings saves bypass limits; startup banners are excluded. Usage resets on restart.</small></section>;
}
