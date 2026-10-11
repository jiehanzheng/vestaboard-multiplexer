import type { ReactNode } from "react";
import { HABlockConfigSchema, type HABlockConfig } from "../../../../src/plugins/haBlock/config.js";
import type { HABlockStatus } from "../../../../src/plugins/haBlock/status.js";
import type { HAEntity } from "../../../../src/contracts/homeAssistant.js";
import { ConfigToggle } from "../../ConfigControls";
import { EntityPicker } from "../../EntityPicker";
import { SettingsGroup } from "../../SettingsGroup";
import { StalenessSettings } from "../../StalenessSettings";

export function HABlockSettings({ value, status, entities, loading, error, layoutError, onChange }: {
  value: HABlockConfig; status?: HABlockStatus; entities: readonly HAEntity[];
  loading: boolean; error?: string; layoutError?: string; onChange: (value: HABlockConfig) => void;
}): ReactNode {
  const validation = HABlockConfigSchema.safeParse(value);
  return <div className="settings-stack">
    <SettingsGroup title="HA character block" description="Show a character block supplied by Home Assistant.">
      <ConfigToggle label="Enable HA character block" checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} />
      <div className="settings-grid">
        <EntityPicker id="ha-block-entity" label="Source entity" value={value.entityId} entities={entities} loading={loading} error={error} onChange={(entityId) => onChange({ ...value, entityId })} />
        <label className="config-field"><span>Character attribute</span><input value={value.attribute} onChange={(event) => onChange({ ...value, attribute: event.target.value })} /></label>
      </div>
      <p className="screen-footnote">The entity must be ready and supply a flat array of Vestaboard character codes. Zero draws a blank cell.</p>
    </SettingsGroup>
    <SettingsGroup title="Block size" description="Characters fill across each row, then continue on the next row. Unused cells stay blank.">
      <div className="settings-grid">
        <label className="config-field"><span>Width (columns)</span><input type="number" min={value.unavailableDisplay === "na" ? 3 : 1} max={22} step={1} value={value.width} onChange={(event) => onChange({ ...value, width: Number(event.target.value) })} /></label>
        <label className="config-field"><span>Height (rows)</span><input type="number" min={1} max={6} step={1} value={value.height} onChange={(event) => onChange({ ...value, height: Number(event.target.value) })} /></label>
      </div>
      <p className="screen-footnote">Size and layout save together. Place the block on Board; resizing keeps its position and must fit without overlapping other elements.</p>
    </SettingsGroup>
    <SettingsGroup title="Unavailable display" description="Choose what appears immediately when the source is missing, disconnected, or invalid. Healthy blank data stays blank.">
      <label className="config-field"><span>When unavailable</span><select value={value.unavailableDisplay} onChange={(event) => onChange({ ...value, unavailableDisplay: event.target.value === "na" ? "na" : "blank" })}>
        <option value="blank">Blank</option><option value="na" disabled={value.width < 3}>N/A</option>
      </select><small className="field-hint">N/A needs three columns on one row. Choose Blank before reducing the width below three.</small></label>
      {status?.error ? <p className="inline-message error" role="status">{status.stale ? "Stale: " : ""}{status.error}</p> : null}
    </SettingsGroup>
    <StalenessSettings toggleLabel="Mark prolonged failures as stale" value={value.staleAfterMinutes} description="Mark a source stale after this long without valid data. Healthy unchanged data does not expire." footnote="Unavailable data uses the chosen display immediately. This timer marks prolonged failures in diagnostics; board writes follow the delivery interval." onChange={(staleAfterMinutes) => onChange({ ...value, staleAfterMinutes })} />
    {validation.success && layoutError ? <p className="inline-message error" role="alert">{layoutError}</p> : null}
    {!validation.success ? <p className="inline-message error" role="alert">{validation.error.issues.map((issue) => issue.message).join(" ")}</p> : null}
  </div>;
}
