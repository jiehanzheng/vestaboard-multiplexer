import type { ReactNode } from "react";

export function ConfigSelect({ label, value, options, locked, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; locked: boolean; onChange: (value: string) => void }): ReactNode {
  return <label className="config-field"><span>{label}{locked ? <LockMark /> : null}</span><select value={value} disabled={locked} onChange={(event) => onChange(event.target.value)}><option value="">Not set</option>{options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>;
}

export function ConfigNumber({ label, value, locked, onChange }: { label: string; value: string; locked: boolean; onChange: (value: number) => void }): ReactNode {
  return <label className="config-field"><span>{label}{locked ? <LockMark /> : null}</span><input type="number" min={0} value={value} disabled={locked} placeholder="Not set" onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

export function ConfigToggle({ label, checked, locked, onChange }: { label: string; checked: boolean; locked: boolean; onChange: (value: boolean) => void }): ReactNode {
  return <label className="config-toggle"><input type="checkbox" checked={checked} disabled={locked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span>{locked ? <LockMark /> : null}</label>;
}

export function LockMark(): ReactNode { return <span className="lock-mark" title="Managed by environment" aria-label="Managed by environment">⌑</span>; }
