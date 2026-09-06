import { useMemo, useState, type ReactNode } from "react";
import type { HAEntity } from "../../src/contracts/homeAssistant";

export interface EntityPickerProps {
  id: string;
  label: string;
  value: string;
  entities: readonly HAEntity[];
  loading?: boolean;
  error?: string;
  onChange: (value: string) => void;
}

export function EntityPicker({ id, label, value, entities, loading, error, onChange }: EntityPickerProps): ReactNode {
  const [query, setQuery] = useState("");
  const selected = entities.find((entity) => entity.entity_id === value);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const matches = normalized
      ? entities.filter((entity) => entityLabel(entity).toLowerCase().includes(normalized))
      : [...entities];
    if (value && !matches.some((entity) => entity.entity_id === value)) {
      const saved = selected ?? { entity_id: value, state: "unavailable", attributes: {} };
      return [saved, ...matches];
    }
    return matches;
  }, [entities, query, selected, value]);

  return (
    <label className="config-field" htmlFor={id}>
      <span>{label}</span>
      <input aria-label={`${label} search`} placeholder="Search entities" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Not configured</option>
        {filtered.map((entity) => <option key={entity.entity_id} value={entity.entity_id}>{entityLabel(entity)}</option>)}
      </select>
      {loading ? <small className="field-hint">Loading entities…</small> : null}
      {error ? <small className="inline-message error" role="alert">{error}</small> : null}
    </label>
  );
}

export function entityLabel(entity: HAEntity): string {
  const friendlyName = typeof entity.attributes.friendly_name === "string" ? entity.attributes.friendly_name : entity.entity_id;
  const unit = typeof entity.attributes.unit_of_measurement === "string" ? ` · ${entity.attributes.unit_of_measurement}` : "";
  return `${friendlyName} · ${entity.entity_id} · ${entity.state}${unit}`;
}

export function numericAttributes(entity: HAEntity | undefined): Array<{ name: string; value: number }> {
  if (!entity) return [];
  return Object.entries(entity.attributes)
    .map(([name, value]) => {
      const numeric = numericValue(value);
      return numeric === undefined ? undefined : { name, value: numeric };
    })
    .filter((value): value is { name: string; value: number } => value !== undefined)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function numericValue(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}
