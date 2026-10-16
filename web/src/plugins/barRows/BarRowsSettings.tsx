import { useState, type ReactNode } from "react";
import type { AppConfig } from "../../../../src/contracts/config.js";
import type { HAEntity } from "../../../../src/contracts/homeAssistant.js";
import { BarRowConfigSchema, barRowElementId, type BarRowConfig, type BarRowInput, type BarRowSource } from "../../../../src/plugins/barRows/config.js";
import type { BarRowStatus } from "../../../../src/plugins/barRows/status.js";
import { VESTABOARD_CHARACTER_CATALOG } from "../../../../src/vestaboardCharacters.js";
import { ConfigToggle } from "../../ConfigControls";
import { EntityPicker } from "../../EntityPicker";
import { PluginRow } from "../../PluginRow";
import { SettingsGroup } from "../../SettingsGroup";
import { StalenessSettings } from "../../StalenessSettings";

const fields = ["displayName", "current", "max", "displayText"] as const;
const labels = { displayName: "Display name", current: "Current value", max: "Maximum value", displayText: "Display text" };
const attributes = { displayName: "display_name", current: "current", max: "max", displayText: "display_text" };
type CatalogProps = { entities: readonly HAEntity[]; loading: boolean; error?: string };

export function BarRowsSettings({ config, status, entities, loading, error, layoutError, onChange }: {
  config: AppConfig; status?: Record<string, BarRowStatus>; entities: readonly HAEntity[];
  loading: boolean; error?: string; layoutError?: string; onChange: (config: AppConfig) => void;
}): ReactNode {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = config.barRows.find((row) => row.id === selectedId) ?? config.barRows[0];
  return <div className="settings-stack">
    <div className="section-heading"><div><h2>Bar and text rows</h2><p>Each row has its own sources and fixed text areas. Place and resize it on Board.</p></div>
      <button className="button secondary" type="button" onClick={() => {
        const id = crypto.randomUUID();
        onChange({ ...config, barRows: [...config.barRows, { id, name: "Bar and text row", enabled: false,
          source: { kind: "entity", entityId: "", attributes }, labelWidth: 2, textWidth: 3,
          barCharacter: 67, unavailableDisplay: "na", staleAfterMinutes: 15 }] });
        setSelectedId(id);
      }}>Add row</button>
    </div>
    {config.barRows.length ? <section className="plugin-list" aria-label="Bar and text rows">{config.barRows.map((row) =>
      <PluginRow key={row.id} title={row.name || "Unnamed row"} purpose={row.source.kind === "entity" ? row.source.entityId || "Choose a source entity" : "Individual field bindings"}
        status={selected?.id === row.id ? "Editing" : status?.[row.id]?.error ? "Needs attention" : row.enabled ? "Enabled" : "Disabled"} onOpen={() => setSelectedId(row.id)} />)}</section>
      : <p className="screen-footnote">Add a row, configure its sources, then place it on Board.</p>}
    {selected ? <RowEditor key={selected.id} value={selected} status={status?.[selected.id]} entities={entities} loading={loading} error={error} layoutError={layoutError}
      onChange={(value) => onChange({ ...config, barRows: config.barRows.map((row) => row.id === value.id ? value : row) })}
      onRemove={() => onChange({ ...config, barRows: config.barRows.filter((row) => row.id !== selected.id), layout: config.layout?.filter((entry) => entry.elementId !== barRowElementId(selected.id)) ?? null })} /> : null}
  </div>;
}

function RowEditor({ value, status, entities, loading, error, layoutError, onChange, onRemove }: CatalogProps & {
  value: BarRowConfig; status?: BarRowStatus; layoutError?: string; onChange: (value: BarRowConfig) => void; onRemove: () => void;
}): ReactNode {
  const [alternate, setAlternate] = useState<BarRowSource>();
  const validation = BarRowConfigSchema.safeParse(value);
  const source = value.source;
  return <section className="settings-stack" aria-label={`Edit ${value.name || "unnamed row"}`}>
    <label className="config-field"><span>Row name</span><input value={value.name} maxLength={64} onChange={(event) => onChange({ ...value, name: event.target.value })} /></label>
    <SettingsGroup title="Sources" description="Home Assistant supplies the label, values, and display text. Calculations belong in Home Assistant.">
      <ConfigToggle label="Enable bar and text row" checked={value.enabled} onChange={(enabled) => onChange({ ...value, enabled })} />
      <label className="config-field"><span>Source style</span><select value={source.kind} onChange={(event) => {
        const kind = event.target.value;
        const next: BarRowSource = alternate?.kind === kind ? alternate : kind === "entity"
          ? { kind: "entity", entityId: "", attributes }
          : source.kind === "entity" ? { kind: "fields", ...Object.fromEntries(fields.map((field) => [field, { kind: "entity", entityId: source.entityId, attribute: source.attributes[field] }])), ...(source.attributes.marker ? { marker: { kind: "entity", entityId: source.entityId, attribute: source.attributes.marker } } : {}) } as BarRowSource
          : source;
        setAlternate(source);
        onChange({ ...value, source: next });
      }}><option value="entity">One entity with attributes</option><option value="fields">Individual field bindings</option></select></label>
      {source.kind === "entity" ? <>
        <EntityPicker id={`bar-row-${value.id}-entity`} label="Source entity" value={source.entityId} entities={entities} loading={loading} error={error} onChange={(entityId) => onChange({ ...value, source: { ...source, entityId } })} />
        <div className="settings-grid">{fields.map((field) => <label key={field} className="config-field"><span>{labels[field]} attribute</span><input value={source.attributes[field]} onChange={(event) => onChange({ ...value, source: { ...source, attributes: { ...source.attributes, [field]: event.target.value } } })} /></label>)}</div>
      </> : fields.map((field) => <FieldBinding key={field} id={`bar-row-${value.id}-${field}`} label={labels[field]} numeric={field === "current" || field === "max"} value={source[field]} entities={entities} loading={loading} error={error}
        onChange={(binding) => onChange({ ...value, source: { ...source, [field]: binding } as BarRowSource })} />)}
      {source.kind === "entity" ? <label className="config-field"><span>Marker character attribute (optional)</span><input placeholder="No marker" value={source.attributes.marker ?? ""} onChange={(event) => {
        const { marker: _marker, ...base } = source.attributes;
        onChange({ ...value, source: { ...source, attributes: event.target.value ? { ...base, marker: event.target.value } : base } });
      }} /></label> : <>
        <EntityPicker id={`bar-row-${value.id}-marker`} label="Marker entity (optional)" value={source.marker?.entityId ?? ""} entities={entities} loading={loading} error={error} onChange={(entityId) => {
          const { marker, ...base } = source;
          onChange({ ...value, source: entityId ? { ...base, marker: { kind: "entity", entityId, attribute: marker?.attribute ?? "bar_marker" } } : base });
        }} />
        {source.marker ? <label className="config-field"><span>Marker character attribute</span><input value={source.marker.attribute ?? ""} onChange={(event) => onChange({ ...value, source: { ...source, marker: { ...source.marker!, attribute: event.target.value } } })} /></label> : null}
      </>}
      <p className="screen-footnote">Marker codes render directly inside the bar: [62] is a heart; [] shows no marker. Leave the binding empty to disable it.</p>
      {status?.inputs.marker?.error ? <p className="inline-message error" role="status">Marker: {status.inputs.marker.error}</p> : null}
      {fields.map((field) => status?.inputs[field].error ? <p key={field} className="inline-message error" role="status">{labels[field]}: {status.inputs[field].error}</p> : null)}
      <p className="screen-footnote">Unknown, unavailable, restored, disconnected, or invalid inputs use the fallback immediately. All required fields must be valid together; no previous values are retained.</p>
    </SettingsGroup>
    <SettingsGroup title="Fixed text areas" description="The label aligns left and display text aligns right. The remaining placement columns form the bar; changing text never changes its width.">
      <div className="settings-grid">{(["labelWidth", "textWidth"] as const).map((field) => <label key={field} className="config-field"><span>{field === "labelWidth" ? "Label width (cells)" : "Display text width (cells)"}</span><input type="number" min={0} max={21} step={1} value={value[field]} onChange={(event) => onChange({ ...value, [field]: Number(event.target.value) })} /></label>)}
        <label className="config-field"><span>Bar character</span><select value={value.barCharacter} onChange={(event) => onChange({ ...value, barCharacter: Number(event.target.value) })}>{VESTABOARD_CHARACTER_CATALOG.map((character) => <option key={character.code} value={character.code}>{character.code} · {character.name}</option>)}</select></label>
      </div>
      <p className="screen-footnote">Reserve at least one bar cell. For example, a 15-cell placement with label width 2 and text width 3 leaves ten bar cells. Text is normalized to board characters; overflow uses the fallback instead of truncating. Check Board preview before saving.</p>
    </SettingsGroup>
    <SettingsGroup title="Unavailable display" description="Choose the immediate fallback for invalid inputs, text overflow, or a disconnected source.">
      <label className="config-field"><span>When unavailable</span><select value={value.unavailableDisplay} onChange={(event) => onChange({ ...value, unavailableDisplay: event.target.value === "na" ? "na" : "blank" })}><option value="blank">Blank</option><option value="na">N/A</option></select><small>N/A requires at least three placement columns.</small></label>
      {status?.error ? <p className="inline-message error" role="status">{status.stale ? "Stale: " : ""}{status.error}</p> : null}
    </SettingsGroup>
    <StalenessSettings value={value.staleAfterMinutes} toggleLabel="Mark prolonged failures as stale" description="Mark prolonged failures in diagnostics. Healthy unchanged data does not expire." footnote="Unavailable inputs use the fallback immediately. Board writes follow the delivery limits." onChange={(staleAfterMinutes) => onChange({ ...value, staleAfterMinutes })} />
    {!validation.success ? <p className="inline-message error" role="alert">{validation.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(" ")}</p> : null}
    {layoutError ? <p className="inline-message error" role="alert">{layoutError}</p> : null}
    <button className="button secondary" type="button" onClick={onRemove}>Remove row</button>
    <p className="screen-footnote">Removing a row also removes its layout placements when saved. Discard restores both.</p>
  </section>;
}

function FieldBinding({ id, label, numeric, value, entities, loading, error, onChange }: CatalogProps & {
  id: string; label: string; numeric: boolean; value: BarRowInput; onChange: (value: BarRowInput) => void;
}): ReactNode {
  const [alternate, setAlternate] = useState<BarRowInput>();
  return <fieldset className="settings-stack"><legend>{label}</legend>
    <label className="config-field"><span>{label} source</span><select value={value.kind} onChange={(event) => {
      const kind = event.target.value;
      setAlternate(value);
      onChange(alternate?.kind === kind ? alternate : kind === "constant" ? numeric ? { kind: "constant", value: 0 } : { kind: "constant", value: "" } : { kind: "entity", entityId: "" });
    }}><option value="entity">Home Assistant</option><option value="constant">Constant</option></select></label>
    {value.kind === "constant" ? <label className="config-field"><span>{label} value</span><input type={numeric ? "number" : "text"} step={numeric ? "any" : undefined} value={value.value} onChange={(event) => onChange(numeric ? { kind: "constant", value: Number(event.target.value) } : { kind: "constant", value: event.target.value })} /></label> : <>
      <EntityPicker id={id} label={`${label} entity`} value={value.entityId} entities={entities} loading={loading} error={error} onChange={(entityId) => onChange({ ...value, entityId })} />
      <label className="config-field"><span>{label} attribute (optional)</span><input placeholder="Entity state" value={value.attribute ?? ""} onChange={(event) => onChange({ ...value, attribute: event.target.value || undefined })} /></label>
    </>}
  </fieldset>;
}
