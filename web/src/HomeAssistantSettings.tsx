import { useMemo, useState, type ReactNode } from "react";
import type { HAConfig, HAEntity } from "../../src/homeAssistant";
import type { Input, WaterHeaterConfig } from "../../src/plugins/waterHeater";

export interface HomeAssistantSettingsProps {
  ha: HAConfig;
  water: WaterHeaterConfig;
  hasToken: boolean;
  onChange: (ha: HAConfig, water: WaterHeaterConfig) => void;
}

type Feedback = { tone: "success" | "error"; message: string } | undefined;
type InputField = "remaining" | "capacity" | "temperature" | "target";
type FieldMessage = { tone: "info" | "error"; message: string };

const INPUT_FIELDS: Array<{ key: InputField; label: string; hint: string }> = [
  { key: "remaining", label: "Remaining water", hint: "Current usable water in US gallons." },
  { key: "capacity", label: "Tank capacity", hint: "Maximum usable water in US gallons." },
  { key: "temperature", label: "Tank temperature", hint: "Current tank temperature." },
  { key: "target", label: "Target temperature", hint: "Temperature used as the full bar." }
];

export function HomeAssistantSettings({ ha, water, hasToken, onChange }: HomeAssistantSettingsProps): ReactNode {
  const [feedback, setFeedback] = useState<Feedback>();
  const [entities, setEntities] = useState<HAEntity[]>([]);
  const [busy, setBusy] = useState<"test" | "entities" | undefined>();
  const entityOptions = useMemo(() => entities.map(entityOption), [entities]);

  const updateHa = (patch: Partial<HAConfig>) => onChange({ ...ha, ...patch }, water);
  const updateWater = (patch: Partial<WaterHeaterConfig>) => onChange(ha, { ...water, ...patch });
  const credentialBody = () => ({ url: ha.url, ...(ha.token ? { token: ha.token } : {}) });

  async function testConnection(): Promise<void> {
    setBusy("test");
    setFeedback(undefined);
    try {
      const response = await fetch("/api/ha/test", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(credentialBody())
      });
      const result = await readJson<{ connected?: boolean; error?: string }>(response);
      if (!response.ok || result.connected !== true) {
        setFeedback({ tone: "error", message: "Home Assistant could not be connected. Check the URL and token." });
      } else {
        setFeedback({ tone: "success", message: "Home Assistant connection is ready." });
      }
    } catch {
      setFeedback({ tone: "error", message: "Home Assistant could not be reached." });
    } finally {
      setBusy(undefined);
    }
  }

  async function refreshEntities(): Promise<void> {
    setBusy("entities");
    setFeedback(undefined);
    try {
      const response = await fetch("/api/ha/entities", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(credentialBody())
      });
      const result = await readJson<{ entities?: HAEntity[] }>(response);
      if (!response.ok || !Array.isArray(result.entities)) {
        setFeedback({ tone: "error", message: "Could not load Home Assistant entities." });
      } else {
        setEntities(result.entities);
        setFeedback({ tone: "success", message: `${result.entities.length} entities available.` });
      }
    } catch {
      setFeedback({ tone: "error", message: "Could not load Home Assistant entities." });
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <section className="connection-section" aria-labelledby="home-assistant-heading">
      <div className="section-heading">
        <div>
          <h2 id="home-assistant-heading">Home Assistant</h2>
          <p>Read-only connection for water readings and pause state.</p>
        </div>
        <span className="connection-badge">Read only</span>
      </div>

      <div className="settings-panel">
        <div className="settings-grid">
          <label className="config-field">
            <span>Home Assistant URL</span>
            <input id="ha-url" type="url" value={ha.url} placeholder="http://homeassistant.local:8123" onChange={(event) => updateHa({ url: event.target.value })} />
          </label>
          <label className="config-field">
            <span>Long-lived access token</span>
            <input id="ha-token" type="password" value={ha.token ?? ""} placeholder={hasToken ? "Saved token · type to replace" : "Paste token"} autoComplete="new-password" onChange={(event) => updateHa({ token: event.target.value || undefined })} />
          </label>
        </div>
        <div className="editor-actions">
          <button className="button secondary" type="button" onClick={() => void testConnection()} disabled={busy !== undefined || !ha.url.trim()}>{busy === "test" ? "Testing…" : "Test connection"}</button>
          <button className="button secondary" type="button" onClick={() => void refreshEntities()} disabled={busy !== undefined || !ha.url.trim()}>{busy === "entities" ? "Loading…" : "Refresh entities"}</button>
        </div>
        {feedback ? <p className={`inline-message ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</p> : null}
      </div>

      <section className="settings-panel" aria-labelledby="water-heading">
        <div className="subheading-row"><h3 id="water-heading">Water heater</h3></div>
        <label className="config-toggle"><input type="checkbox" checked={water.enabled} onChange={(event) => updateWater({ enabled: event.target.checked })} /><span>Show water heater readings</span></label>
        <div className="settings-grid">
          {INPUT_FIELDS.map((field) => (
            <WaterInputField
              key={field.key}
              label={field.label}
              hint={field.hint}
              field={field.key}
              input={water[field.key]}
              entities={entityOptions}
              onChange={(input) => updateWater({ [field.key]: input } as Partial<WaterHeaterConfig>)}
            />
          ))}
          <label className="config-field">
            <span>Temperature baseline</span>
            <input id="water-baseline" type="number" value={water.baseline ?? ""} placeholder="Required for bar" onChange={(event) => updateWater({ baseline: event.target.value === "" ? undefined : Number(event.target.value) })} />
            {water.baseline !== undefined && !Number.isFinite(water.baseline) ? <p className="inline-message error" role="alert">Enter a finite number.</p> : null}
          </label>
          <label className="config-field">
            <span>Temperature unit</span>
            <select id="water-unit" value={water.unit} onChange={(event) => updateWater({ unit: event.target.value === "C" ? "C" : "F" })}>
              <option value="F">Fahrenheit (°F)</option>
              <option value="C">Celsius (°C)</option>
            </select>
          </label>
        </div>
      </section>

      <section className="settings-panel" aria-labelledby="pause-heading">
        <div className="subheading-row"><h3 id="pause-heading">Pause from Home Assistant</h3></div>
        <p className="screen-footnote">Updates pause when the selected entity matches the pause value.</p>
        <div className="settings-grid">
          <EntityPicker id="ha-pause-entity" label="Pause entity" value={ha.pause?.entityId ?? ""} entities={entityOptions} onChange={(entityId) => updateHa({ pause: entityId ? { entityId, pauseValue: ha.pause?.pauseValue ?? "on", resumeValue: ha.pause?.resumeValue ?? "off" } : null })} />
          <label className="config-field">
            <span>Pause value</span>
            <input id="ha-pause-value" value={ha.pause?.pauseValue ?? ""} placeholder="on" disabled={!ha.pause} onChange={(event) => ha.pause && updateHa({ pause: { ...ha.pause, pauseValue: event.target.value } })} />
          </label>
          <label className="config-field">
            <span>Resume value</span>
            <input id="ha-resume-value" value={ha.pause?.resumeValue ?? ""} placeholder="off" disabled={!ha.pause} onChange={(event) => ha.pause && updateHa({ pause: { ...ha.pause, resumeValue: event.target.value } })} />
          </label>
        </div>
      </section>
    </section>
  );
}

interface EntityOption {
  entity: HAEntity;
  label: string;
  numericAttributes: Array<{ name: string; value: number }>;
}

function WaterInputField({ field, label, hint, input, entities, onChange }: { field: InputField; label: string; hint: string; input: Input; entities: EntityOption[]; onChange: (input: Input) => void }): ReactNode {
  const mode = input === null ? "off" : "entityId" in input ? "entity" : "constant";
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
        <option value="off">Off</option>
        <option value="constant">Constant</option>
        <option value="entity">Home Assistant entity</option>
      </select>
      {mode === "constant" ? (
        <input aria-label={`${label} constant`} type="number" value={input && "constant" in input && Number.isFinite(input.constant) ? input.constant : ""} onChange={(event) => onChange({ constant: event.target.value === "" ? 0 : Number(event.target.value) })} />
      ) : null}
      {mode === "entity" ? <EntityInput input={input && "entityId" in input ? input : { entityId: "" }} entities={entities} label={label} onChange={onChange} /> : null}
      {message ? <p className={`inline-message ${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.message}</p> : null}
    </fieldset>
  );
}

function EntityInput({ input, entities, label, onChange }: { input: { entityId: string; attribute?: string }; entities: EntityOption[]; label: string; onChange: (input: Input) => void }): ReactNode {
  const [query, setQuery] = useState("");
  const selected = entities.find(({ entity }) => entity.entity_id === input.entityId) ?? (input.entityId ? savedEntityOption(input.entityId) : undefined);
  const filteredEntities = includeSelected(filterEntities(entities, query), selected);
  const attributeOptions = selected ? selected.numericAttributes : [];
  const selectedAttribute = input.attribute && !attributeOptions.some(({ name }) => name === input.attribute)
    ? [{ name: input.attribute, label: `${input.attribute} · ${entities.length === 0 ? "saved selection · refresh to load" : "unavailable"}` }]
    : [];
  return (
    <>
      <input aria-label={`${label} entity search`} placeholder="Search entities" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select aria-label={`${label} entity`} value={input.entityId} onChange={(event) => onChange({ entityId: event.target.value })}>
        <option value="">Choose an entity</option>
        {filteredEntities.map(({ entity, label: optionLabel }) => <option key={entity.entity_id} value={entity.entity_id}>{optionLabel}</option>)}
      </select>
      <label className="config-field">
        <span>{label} numeric value</span>
        <select aria-label={`${label} numeric attribute`} value={input.attribute ?? ""} disabled={!input.entityId} onChange={(event) => onChange({ entityId: input.entityId, attribute: event.target.value || undefined })}>
          <option value="">Entity state{selected ? ` · ${selected.entity.state}` : ""}</option>
          {attributeOptions.map(({ name, value }) => <option key={name} value={name}>{name} · {value}</option>)}
          {selectedAttribute.map(({ name, label: optionLabel }) => <option key={name} value={name}>{optionLabel}</option>)}
        </select>
      </label>
    </>
  );
}

function EntityPicker({ id, label, value, entities, onChange }: { id: string; label: string; value: string; entities: EntityOption[]; onChange: (value: string) => void }): ReactNode {
  const [query, setQuery] = useState("");
  const selected = entities.find(({ entity }) => entity.entity_id === value) ?? (value ? savedEntityOption(value) : undefined);
  const filteredEntities = includeSelected(filterEntities(entities, query), selected);
  return (
    <label className="config-field">
      <span>{label}</span>
      <input aria-label={`${label} search`} placeholder="Search entities" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Not configured</option>
        {filteredEntities.map(({ entity, label: optionLabel }) => <option key={entity.entity_id} value={entity.entity_id}>{optionLabel}</option>)}
      </select>
    </label>
  );
}

function filterEntities(entities: EntityOption[], query: string): EntityOption[] {
  const normalized = query.trim().toLowerCase();
  return normalized ? entities.filter(({ label }) => label.toLowerCase().includes(normalized)) : entities;
}

function includeSelected(entities: EntityOption[], selected: EntityOption | undefined): EntityOption[] {
  if (!selected || entities.some(({ entity }) => entity.entity_id === selected.entity.entity_id)) return entities;
  return [selected, ...entities];
}

function entityOption(entity: HAEntity): EntityOption {
  const friendlyName = typeof entity.attributes.friendly_name === "string" ? entity.attributes.friendly_name : entity.entity_id;
  const unit = typeof entity.attributes.unit_of_measurement === "string" ? ` · ${entity.attributes.unit_of_measurement}` : "";
  const numericAttributes = Object.entries(entity.attributes)
    .map(([name, value]) => {
      const numeric = numericValue(value);
      return numeric === undefined ? undefined : { name, value: numeric };
    })
    .filter((value): value is { name: string; value: number } => value !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name));
  return { entity, label: `${friendlyName} · ${entity.entity_id} · ${entity.state}${unit}`, numericAttributes };
}

function savedEntityOption(entityId: string): EntityOption {
  return {
    entity: { entity_id: entityId, state: "unavailable", attributes: {} },
    label: `${entityId} · saved selection · refresh to load`,
    numericAttributes: []
  };
}

function inputValidationMessage(field: InputField, input: Input, entities: EntityOption[]): FieldMessage | undefined {
  if (input === null) return undefined;
  if ("constant" in input) {
    if (!Number.isFinite(input.constant)) return { tone: "error", message: "Enter a finite number." };
    if (field === "remaining" && input.constant < 0) return { tone: "error", message: "Enter zero or more." };
    if (field === "capacity" && input.constant <= 0) return { tone: "error", message: "Enter a positive number." };
    return undefined;
  }
  if (entities.length === 0) return { tone: "info", message: "Refresh entities to load current values." };
  if (!input.entityId) return { tone: "error", message: "Choose a Home Assistant entity." };
  const selected = entities.find(({ entity }) => entity.entity_id === input.entityId);
  if (!selected) return { tone: "error", message: "Selected entity is unavailable. Refresh entities or choose another." };
  const value = input.attribute ? selected.entity.attributes[input.attribute] : selected.entity.state;
  if (numericValue(value) === undefined) return { tone: "error", message: "Selected value is unavailable or not numeric." };
  return undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

async function readJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}
