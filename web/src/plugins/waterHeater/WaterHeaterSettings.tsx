import type { ReactNode } from "react";
import { WaterHeaterConfigSchema, type WaterHeaterConfig } from "../../../../src/contracts/config";
import type { HAEntity } from "../../../../src/contracts/homeAssistant";
import type { WaterHeaterInputName, WaterHeaterStatus } from "../../../../src/plugins/waterHeater/status.js";
import { EntityPicker, numericAttributes, numericValue } from "../../EntityPicker";

type Input = WaterHeaterConfig["remaining"];
type InputField = WaterHeaterInputName;

const INPUT_FIELDS: Array<{ key: InputField; label: string; hint: string }> = [
  { key: "remaining", label: "Remaining water", hint: "Current usable water in US gallons." },
  { key: "capacity", label: "Tank capacity", hint: "Maximum usable water in US gallons." },
  { key: "temperature", label: "Tank temperature", hint: "Current tank temperature." },
  { key: "target", label: "Target temperature", hint: "Target temperature used in the divider display." },
  { key: "emvPosition", label: "EMV position", hint: "Movement value shown as MVnnnn, rounded to a whole number." }
];

export function WaterHeaterSettings({ value, status, saved = true, entities, loading, error, onChange }: {
  value: WaterHeaterConfig;
  status?: WaterHeaterStatus;
  saved?: boolean;
  entities: readonly HAEntity[];
  loading: boolean;
  error?: string;
  onChange: (value: WaterHeaterConfig) => void;
}): ReactNode {
  return (
    <div className="settings-panel">
      <label className="config-toggle"><input type="checkbox" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} /><span>Show water heater readings</span></label>
      {!saved ? <p className="inline-message info" role="status">Unsaved changes. Save Water Heater to update live readings.</p> : !value.enabled ? <p className="inline-message info" role="status">Disabled. Water heater readings will remain blank on allocated board ranges.</p> : status?.error ? <p className="inline-message error" role="alert">{status.error}</p> : <p className="inline-message info" role="status">Saved current readings are shown for the configured inputs.</p>}
      <div className="settings-grid">
        {INPUT_FIELDS.map((field) => (
          <WaterInputField key={field.key} label={field.label} hint={field.hint} field={field.key} input={value[field.key] ?? null} status={saved ? status?.inputs[field.key] : undefined} entities={entities} loading={loading} error={error} onChange={(input) => onChange({ ...value, [field.key]: input } as WaterHeaterConfig)} />
        ))}
        <HeatingInputField input={value.heating ?? null} status={saved ? status?.inputs.heating : undefined} entities={entities} loading={loading} error={error} onChange={(heating) => onChange({ ...value, heating })} />
        <label className="config-field">
          <span>Temperature unit</span>
          <select id="water-unit" value={value.unit} onChange={(event) => onChange({ ...value, unit: event.target.value === "C" ? "C" : "F" })}>
            <option value="F">Fahrenheit (°F)</option>
            <option value="C">Celsius (°C)</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function HeatingInputField({ input, status, entities, loading, error, onChange }: { input: WaterHeaterConfig["heating"] | null; status?: WaterHeaterStatus["inputs"]["heating"]; entities: readonly HAEntity[]; loading: boolean; error?: string; onChange: (input: WaterHeaterConfig["heating"]) => void }): ReactNode {
  const configured = input ?? null;
  const selected = configured ? entities.find((entity) => entity.entity_id === configured.entityId) : undefined;
  const normalizedState = selected?.state.trim().toLowerCase();
  const validState = normalizedState === undefined || ["on", "off", "true", "false", "1", "0"].includes(normalizedState);
  return (
    <fieldset className="config-field">
      <legend>Heating state</legend>
      <span>Optional binary Home Assistant entity. An on state uses the heart divider between temperatures.</span>
      <EntityPicker id="water-heating-entity" label="Heating entity" value={configured?.entityId ?? ""} entities={entities} loading={loading} error={error} onChange={(entityId) => onChange(entityId ? { entityId } : null)} />
      {selected && !validState ? <p className="inline-message error" role="alert">Entity state is not recognized as on or off; the divider stays `/`.</p> : null}
      {status ? <p className={`screen-footnote${status.error ? " error-text" : ""}`} role={status.error ? "alert" : "status"}>{status.error ? `Saved heating error: ${status.error}` : status.value === undefined ? "Saved input has no current state." : `Saved heating state: ${status.value ? "on" : "off"}`}</p> : null}
    </fieldset>
  );
}

function WaterInputField({ field, label, hint, input, status, entities, loading, error, onChange }: { field: InputField; label: string; hint: string; input: Input; status?: WaterHeaterStatus["inputs"][WaterHeaterInputName]; entities: readonly HAEntity[]; loading: boolean; error?: string; onChange: (input: Input) => void }): ReactNode {
  const mode = input === null ? "off" : "entityId" in input ? "entity" : "constant";
  const selected = input && "entityId" in input ? entities.find((entity) => entity.entity_id === input.entityId) : undefined;
  const attributeOptions = numericAttributes(selected);
  const configuredAttribute = input && "entityId" in input ? input.attribute : undefined;
  const hasConfiguredAttribute = Boolean(configuredAttribute && !attributeOptions.some(({ name }) => name === configuredAttribute));
  const message = inputValidationMessage(field, input, entities);
  return (
    <fieldset className="config-field">
      <legend>{label}</legend>
      <span>{hint}</span>
      <select aria-label={`${label} source`} value={mode} onChange={(event) => {
        if (event.target.value === "off") onChange(null);
        else if (event.target.value === "constant") onChange({ constant: input && "constant" in input ? input.constant : 0 });
        else onChange({ entityId: input && "entityId" in input ? input.entityId : "", attribute: input && "entityId" in input ? input.attribute : undefined });
      }}>
        <option value="off">Off</option><option value="constant">Constant</option><option value="entity">Home Assistant entity</option>
      </select>
      {mode === "constant" ? <input aria-label={`${label} constant`} type="number" value={input && "constant" in input && Number.isFinite(input.constant) ? input.constant : ""} onChange={(event) => onChange({ constant: event.target.value === "" ? 0 : Number(event.target.value) })} /> : null}
      {mode === "entity" ? <EntityInput input={input && "entityId" in input ? input : { entityId: "" }} entities={entities} loading={loading} error={error} label={label} onChange={onChange} hasConfiguredAttribute={hasConfiguredAttribute} attributeOptions={attributeOptions} /> : null}
      {message ? <p className={`inline-message ${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.message}</p> : null}
      {status ? <p className={`screen-footnote${status.error ? " error-text" : ""}`} role={status.error ? "alert" : "status"}>{status.error ? `Saved reading error: ${status.error}${status.value === undefined ? "" : ` · last good value: ${status.value}`}${status.retained ? " · retained" : ""}` : status.configured ? status.value === undefined ? "Saved input has no current reading." : `Saved reading: ${status.value}` : "Not configured."}</p> : null}
    </fieldset>
  );
}

function EntityInput({ input, entities, loading, error, label, onChange, hasConfiguredAttribute, attributeOptions }: { input: { entityId: string; attribute?: string }; entities: readonly HAEntity[]; loading: boolean; error?: string; label: string; onChange: (input: Input) => void; hasConfiguredAttribute: boolean; attributeOptions: Array<{ name: string; value: number }> }): ReactNode {
  const selected = entities.find((entity) => entity.entity_id === input.entityId);
  return (
    <>
      <EntityPicker id={`${label.toLowerCase().replaceAll(" ", "-")}-entity`} label={`${label} entity`} value={input.entityId} entities={entities} loading={loading} error={error} onChange={(entityId) => onChange({ entityId, attribute: input.attribute })} />
      <label className="config-field">
        <span>{label} numeric value</span>
        <select aria-label={`${label} numeric attribute`} value={input.attribute ?? ""} disabled={!input.entityId} onChange={(event) => onChange({ entityId: input.entityId, attribute: event.target.value || undefined })}>
          <option value="">Entity state{selected ? ` · ${selected.state}` : ""}</option>
          {attributeOptions.map(({ name, value }) => <option key={name} value={name}>{name} · {value}</option>)}
          {hasConfiguredAttribute && input.attribute ? <option value={input.attribute}>{input.attribute} · saved selection · refresh to load</option> : null}
        </select>
      </label>
    </>
  );
}

function inputValidationMessage(field: InputField, input: Input, entities: readonly HAEntity[]): { tone: "info" | "error"; message: string } | undefined {
  if (input === null) return undefined;
  if ("constant" in input) {
    const candidate = {
      remaining: null,
      capacity: null,
      temperature: null,
      target: null,
      emvPosition: null,
      unit: "F" as const,
      enabled: false,
      [field]: input
    };
    const result = WaterHeaterConfigSchema.safeParse(candidate);
    if (!result.success) {
      const issue = result.error.issues.find((item) => item.path[0] === field);
      if (issue) return { tone: "error", message: issue.message };
    }
    return undefined;
  }
  if (entities.length === 0) return { tone: "info", message: "Refresh entities to load current values." };
  if (!input.entityId) return { tone: "error", message: "Choose a Home Assistant entity." };
  const selected = entities.find((entity) => entity.entity_id === input.entityId);
  if (!selected) return { tone: "error", message: "Selected entity is unavailable. Refresh entities or choose another." };
  const value = input.attribute ? selected.attributes[input.attribute] : selected.state;
  if (numericValue(value) === undefined) return { tone: "error", message: "Selected value is unavailable or not numeric." };
  return undefined;
}
