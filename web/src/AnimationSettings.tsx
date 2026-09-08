import type { ReactNode } from "react";
import type { LocalMessageTransitionOptions, LocalMessageTransitionStrategy } from "../../src/contracts/config";

const STRATEGIES: Array<{ value: LocalMessageTransitionStrategy; label: string }> = [
  { value: "row", label: "Rows" },
  { value: "column", label: "Columns" },
  { value: "reverse-column", label: "Reverse columns" },
  { value: "edges-to-center", label: "Edges to center" },
  { value: "diagonal", label: "Diagonal" },
  { value: "random", label: "Random" }
];

export function AnimationSettings({ value, onChange, disabled = false }: { value: LocalMessageTransitionOptions; onChange: (value: LocalMessageTransitionOptions) => void; disabled?: boolean }): ReactNode {
  return <div className="settings-grid">
    <label className="config-field"><span>Animation strategy</span><select value={value.strategy} disabled={disabled} onChange={(event) => onChange({ ...value, strategy: event.target.value as LocalMessageTransitionStrategy })}>{STRATEGIES.map((strategy) => <option value={strategy.value} key={strategy.value}>{strategy.label}</option>)}</select></label>
    <label className="config-field"><span>Delay between steps (ms)</span><input type="number" min="1" step="1" value={String(value.stepIntervalMs)} disabled={disabled} onChange={(event) => onChange({ ...value, stepIntervalMs: Number(event.target.value) })} /></label>
    <label className="config-field"><span>Step size</span><input type="number" min="1" step="1" value={String(value.stepSize)} disabled={disabled} onChange={(event) => onChange({ ...value, stepSize: Number(event.target.value) })} /></label>
  </div>;
}

export function PauseAnimationSettings({ normal, value, onChange, disabled = false }: { normal: LocalMessageTransitionOptions; value: LocalMessageTransitionOptions | undefined; onChange: (value: LocalMessageTransitionOptions | undefined) => void; disabled?: boolean }): ReactNode {
  const usesOverride = value !== undefined;
  return <div className="pause-animation-settings">
    <label className="config-field"><span>Pause and resume animation</span><select value={usesOverride ? "custom" : "normal"} disabled={disabled} onChange={(event) => onChange(event.target.value === "custom" ? (value ?? structuredClone(normal)) : undefined)}><option value="normal">Same as normal</option><option value="custom">Use a pause override</option></select></label>
    {usesOverride && value ? <AnimationSettings value={value} onChange={onChange} disabled={disabled} /> : <p className="screen-footnote">Pause and resume use the normal Local API animation.</p>}
  </div>;
}

export function localAnimationStrategyLabel(strategy: LocalMessageTransitionStrategy): string {
  return STRATEGIES.find((candidate) => candidate.value === strategy)?.label ?? strategy;
}
