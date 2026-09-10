import type { ReactNode } from "react";
import { ConfigToggle } from "./ConfigControls";
import { SettingsGroup } from "./SettingsGroup";

export function StalenessSettings({ value, description, onChange }: { value: number | null | undefined; description: string; onChange: (value: number | null) => void }): ReactNode {
  return <SettingsGroup title="Stale readings" description={description}>
    <ConfigToggle label="Expire old readings" checked={value !== null} onChange={(enabled) => onChange(enabled ? 15 : null)} />
    {value !== null ? <label className="config-field"><span>Stale after (minutes)</span><input type="number" min="0.01" step="any" value={value ?? 15} aria-invalid={value !== undefined && value <= 0 ? true : undefined} onChange={(event) => onChange(Number(event.target.value))} />{value !== undefined && value <= 0 ? <small className="error-text">Enter a positive number of minutes.</small> : null}</label> : null}
    <p className="screen-footnote">{value === null ? "Old readings never expire." : "Expired readings display N/A. Board updates still follow the delivery interval."}</p>
  </SettingsGroup>;
}
