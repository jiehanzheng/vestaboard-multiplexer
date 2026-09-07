import type { ReactNode } from "react";

export function ConfigSelect({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }): ReactNode {
  return <label className="config-field"><span>{label}</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">Not set</option>{options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>;
}

export function ConfigNumber({ label, value, onChange }: { label: string; value: string; onChange: (value: number) => void }): ReactNode {
  return <label className="config-field"><span>{label}</span><input type="number" min={0} value={value} placeholder="Not set" onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

export function ConfigToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }): ReactNode {
  return <label className="config-toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}
