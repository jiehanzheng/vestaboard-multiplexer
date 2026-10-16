import type { HAEntity } from "../contracts/homeAssistant.js";
import type { HomeAssistantService, HomeAssistantSnapshot } from "../homeAssistantService.js";
import type { Element } from "../elements.js";
import { BLANK, encodeDisplayText, isValidCharacterCode } from "../vestaboardCharacters.js";
import { BarRowsSchema, barRowElementId, barRowGeometry, type BarRowConfig, type BarRowInput } from "./barRows/config.js";
import { type BarRowField, type BarRowStatus } from "./barRows/status.js";
export * from "./barRows/config.js";
export * from "./barRows/status.js";

type Values = { displayName: string; current: number; max: number; displayText: string; marker: number[] };
function bindings(config: BarRowConfig): Record<BarRowField, BarRowInput> & { marker?: BarRowInput } {
  const source = config.source;
  if (source.kind === "fields") {
    const { kind: _kind, ...fields } = source;
    return fields;
  }
  return Object.fromEntries(Object.entries(source.attributes).map(([field, attribute]) => [field,
    { kind: "entity", entityId: source.entityId, attribute }])) as Record<BarRowField, BarRowInput> & { marker?: BarRowInput };
}
function resolve(input: BarRowInput, entities: Map<string, HAEntity>, connected: boolean): unknown {
  if (input.kind === "constant") return input.value;
  const entity = entities.get(input.entityId);
  // HA attributes can survive loss of their source; never mix those with fresh fields.
  if (!connected || !entity || entity.attributes.restored || ["unknown", "unavailable"].includes(entity.state)) throw new Error(`${input.entityId} is unavailable, disconnected, or restored.`);
  return input.attribute ? entity.attributes[input.attribute] : entity.state;
}
function numeric(value: unknown): number {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) throw new Error("Value must be numeric.");
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error("Value must be finite.");
  return number;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Value must be text.");
  return value;
}
function evaluate(config: BarRowConfig, entities: readonly HAEntity[], connected: boolean): { status: BarRowStatus; values?: Values } {
  const inputs = {} as BarRowStatus["inputs"];
  const values: Partial<Values> = { marker: [] };
  const map = new Map(entities.map((entity) => [entity.entity_id, entity]));
  const sources = bindings(config);
  for (const [field, binding] of Object.entries(sources) as [BarRowField | "marker", BarRowInput][]) {
    inputs[field] = { configured: true };
    if (!config.enabled) continue;
    try {
      const raw = resolve(binding, map, connected);
      if (field === "marker") {
        if (!Array.isArray(raw) || !raw.every((code) => typeof code === "number" && isValidCharacterCode(code))) {
          throw new Error("Marker must be an array of supported integer character codes; use [] for no marker.");
        }
        values.marker = raw;
        inputs.marker!.value = raw;
      } else if (field === "current" || field === "max") {
        const number = numeric(raw);
        if (field === "max" && number <= 0) throw new Error("Maximum must be positive.");
        values[field] = number;
        inputs[field].value = number;
      } else {
        const value = text(raw);
        const width = field === "displayName" ? config.labelWidth : config.textWidth;
        if (encodeDisplayText(value).length > width) throw new Error(`Text needs more than the reserved ${width} cells.`);
        values[field] = value;
        inputs[field].value = value;
      }
    } catch (error) { inputs[field].error = error instanceof Error ? error.message : String(error); }
  }
  const error = Object.entries(inputs).flatMap(([field, input]) => input.error ? [`${field}: ${input.error}`] : []).join(" ");
  return { status: { enabled: config.enabled, state: !config.enabled ? "inactive" : error ? "unavailable" : "active", inputs, stale: false, ...(error ? { error } : {}) },
    ...(config.enabled && !error ? { values: values as Values } : {}) };
}
function padded(text: string, width: number, alignment: "left" | "right" = "left"): number[] {
  const cells = encodeDisplayText(text);
  const padding = Array(Math.max(0, width - cells.length)).fill(BLANK);
  return alignment === "right" ? [...padding, ...cells] : [...cells, ...padding];
}
function makeElement(config: BarRowConfig, result: ReturnType<typeof evaluate>): Element {
  return { id: barRowElementId(config.id), label: config.name, ...barRowGeometry(config), state: result.status.state,
    render(width) {
      if (!config.enabled) return [Array(width).fill(BLANK)];
      const barWidth = width - config.labelWidth - config.textWidth;
      if (!result.values || barWidth < 1 || result.values.marker.length > barWidth) return [config.unavailableDisplay === "na" && width >= 3 ? padded("N/A", width) : Array(width).fill(BLANK)];
      const { displayName, current, max, displayText, marker } = result.values;
      const fill = Math.ceil(Math.max(0, Math.min(1, current / max)) * barWidth);
      const bar = [...Array(fill).fill(config.barCharacter), ...Array(barWidth - fill).fill(BLANK)];
      // Keep HA's marker intact inside the bar, including when the fill reaches its end.
      bar.splice(Math.min(fill, barWidth - marker.length), marker.length, ...marker);
      return [[...padded(displayName, config.labelWidth), ...bar, ...padded(displayText, config.textWidth, "right")]];
    } };
}
export function barRowEntityIds(configs: readonly BarRowConfig[]): string[] {
  return [...new Set(configs.filter((config) => config.enabled).flatMap((config) => Object.values(bindings(config)).flatMap((input) => input.kind === "entity" ? [input.entityId] : [])))];
}
export function createBarRowsIntegration(configs: BarRowConfig[], source: Pick<HomeAssistantService, "snapshot" | "subscribe">, changed: () => void, now: () => Date = () => new Date()) {
  let current = structuredClone(configs);
  let statuses: Record<string, BarRowStatus> = {};
  const unavailable = new Map<string, { binding: string; since: number }>();
  let identity: string | undefined;
  function update(snapshot: HomeAssistantSnapshot) {
    if (identity !== snapshot.source) { unavailable.clear(); identity = snapshot.source; }
    const previous = JSON.stringify(statuses);
    statuses = Object.fromEntries(current.map((config) => {
      const { status } = evaluate(config, snapshot.entities, snapshot.connected);
      const binding = JSON.stringify(config.source);
      if (status.error) {
        let record = unavailable.get(config.id);
        if (!record || record.binding !== binding) { record = { binding, since: now().getTime() }; unavailable.set(config.id, record); }
        status.unavailableSince = new Date(record.since).toISOString();
        status.stale = config.staleAfterMinutes !== null && now().getTime() - record.since >= config.staleAfterMinutes * 60000;
      } else unavailable.delete(config.id);
      return [config.id, status];
    }));
    for (const id of unavailable.keys()) if (!current.some((config) => config.id === id)) unavailable.delete(id);
    if (JSON.stringify(statuses) !== previous) changed();
  }
  let unsubscribe = source.subscribe(barRowEntityIds(current), update);
  update(source.snapshot(barRowEntityIds(current)));
  return { id: "bar-rows", slug: "bar-rows", get enabled() { return current.some((config) => config.enabled); },
    configure(configs: BarRowConfig[]) { unsubscribe(); current = BarRowsSchema.parse(configs); unsubscribe = source.subscribe(barRowEntityIds(current), update); update(source.snapshot(barRowEntityIds(current))); changed(); },
    elements(draft = current, snapshot = source.snapshot(barRowEntityIds(draft))) { return BarRowsSchema.parse(draft).map((config) => makeElement(config, evaluate(config, snapshot.entities, snapshot.connected))); },
    previewStatus(draft = current, snapshot = source.snapshot(barRowEntityIds(draft))) { return Object.fromEntries(BarRowsSchema.parse(draft).map((config) => [config.id, evaluate(config, snapshot.entities, snapshot.connected).status])); },
    status: () => Object.fromEntries(Object.entries(statuses).map(([id, status]) => {
      const config = current.find((row) => row.id === id)!;
      const since = unavailable.get(id)?.since;
      return [id, { ...structuredClone(status), stale: since !== undefined && config.staleAfterMinutes !== null && now().getTime() - since >= config.staleAfterMinutes * 60000 }];
    })), stop() { unsubscribe(); }
  };
}
