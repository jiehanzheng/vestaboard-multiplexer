import type { Element } from "../elements.js";
import { BLANK, encode } from "../vestaboardCharacters.js";
import type { HAEntity } from "../contracts/homeAssistant.js";
import type { HomeAssistantService } from "../homeAssistantService.js";
import {
  DEFAULT_WATER_HEATER_CONFIG,
  validateWaterHeaterConfig,
  type Input,
  type WaterHeaterConfig
} from "./waterHeater/config.js";
import {
  emptyWaterHeaterStatus,
  WaterHeaterStatusSchema,
  type WaterHeaterInputName,
  type WaterHeaterStatus
} from "./waterHeater/status.js";

export {
  ConstantInputSchema,
  DEFAULT_WATER_HEATER_CONFIG,
  EntityInputSchema,
  HeatingInputSchema,
  InputSchema,
  normalizeLegacyWaterHeaterConfig,
  validateWaterHeaterConfig,
  WaterHeaterConfigBaseSchema,
  WaterHeaterConfigPatchSchema,
  WaterHeaterConfigSchema
} from "./waterHeater/config.js";
export { WaterHeaterStatusSchema, emptyWaterHeaterStatus, waterElementIssue } from "./waterHeater/status.js";
export type { ConstantInput, EntityInput, HeatingInput, Input, WaterHeaterConfig, WaterHeaterConfigPatch } from "./waterHeater/config.js";
export type { WaterHeaterStatus } from "./waterHeater/status.js";

interface WaterReadings {
  remaining?: number;
  capacity?: number;
  temperature?: number;
  target?: number;
  emvPosition?: number;
  heating?: boolean;
}

export class WaterHeater {
  private config: WaterHeaterConfig;
  private readings: WaterReadings = {};
  private bindings: Record<keyof WaterReadings, string> = {
    remaining: "remaining:none",
    capacity: "capacity:none",
    temperature: "temperature:none",
    target: "target:none",
    emvPosition: "emvPosition:none",
    heating: "heating:none"
  };
  private diagnostic: string | undefined;
  private inputDiagnostics = emptyWaterHeaterStatus().inputs;
  private elementIssues: Record<string, string> = {};

  constructor(config: WaterHeaterConfig = DEFAULT_WATER_HEATER_CONFIG) {
    this.config = cloneConfig(config);
  }

  update(config: WaterHeaterConfig, entities: readonly HAEntity[] = [], connected = true): WaterHeaterStatus {
    const nextConfig = cloneConfig(config);
    const errors = validateWaterHeaterConfig(nextConfig);
    this.config = errors.length ? cloneConfig({ ...DEFAULT_WATER_HEATER_CONFIG, enabled: false }) : nextConfig;
    this.diagnostic = errors[0];
    this.elementIssues = {};
    if (errors.length) {
      this.inputDiagnostics = buildInputDiagnostics(nextConfig, {}, errors);
      return this.status();
    }

    const entityMap = new Map(entities.map((entity) => [entity.entity_id, entity]));
    for (const field of ["remaining", "capacity", "temperature", "target", "emvPosition", "heating"] as const) {
      const input = nextConfig[field] ?? null;
      const binding = inputBinding(field, input);
      if (this.bindings[field] !== binding) {
        this.bindings[field] = binding;
        delete this.readings[field];
      }
    }
    this.inputDiagnostics = buildInputDiagnostics(nextConfig, this.readings, errors);
    for (const field of ["remaining", "capacity", "temperature", "target", "emvPosition"] as const) {
      const input = nextConfig[field] ?? null;
      const diagnostic = this.inputDiagnostics[field];
      if (!nextConfig.enabled || input === null) continue;

      if (!connected && isEntityInput(input)) {
        const error = connectionError(input);
        diagnostic.error = error;
        if (this.readings[field] !== undefined) diagnostic.retained = true;
        this.diagnostic ??= `${field}: ${error}`;
        continue;
      }

      const resolution = resolveInput(input, entityMap);
      if (resolution.value === undefined || !validReading(field, resolution.value)) {
        const error = resolution.error ?? readingError(field, resolution.value);
        diagnostic.error = error;
        if (this.readings[field] !== undefined) diagnostic.retained = true;
        this.diagnostic ??= `${field}: ${error}`;
        continue;
      }
      this.readings[field] = resolution.value;
      diagnostic.value = resolution.value;
      delete diagnostic.error;
      delete diagnostic.retained;
    }

    const heatingInput = nextConfig.heating ?? null;
    const heatingDiagnostic = this.inputDiagnostics.heating;
    if (nextConfig.enabled && heatingInput !== null && heatingInput !== undefined) {
      if (!connected) {
        delete this.readings.heating;
        delete heatingDiagnostic.value;
        delete heatingDiagnostic.retained;
        heatingDiagnostic.error = connectionError(heatingInput);
        this.diagnostic ??= `heating: ${heatingDiagnostic.error}`;
        return this.status();
      }
      const resolution = resolveHeatingInput(heatingInput, entityMap);
      if (resolution.value === undefined) {
        delete this.readings.heating;
        heatingDiagnostic.error = resolution.error ?? "heating state is unavailable.";
        delete heatingDiagnostic.value;
        delete heatingDiagnostic.retained;
        this.diagnostic ??= `heating: ${heatingDiagnostic.error}`;
      } else {
        this.readings.heating = resolution.value;
        heatingDiagnostic.value = resolution.value;
        delete heatingDiagnostic.error;
        delete heatingDiagnostic.retained;
      }
    }
    return this.status();
  }

  /** Drops readings that came from a different Home Assistant source. */
  resetSource(config: WaterHeaterConfig): void {
    this.config = cloneConfig(config);
    this.readings = {};
    this.bindings = {
      remaining: "remaining:none",
      capacity: "capacity:none",
      temperature: "temperature:none",
      target: "target:none",
      emvPosition: "emvPosition:none",
      heating: "heating:none"
    };
    this.diagnostic = undefined;
    this.inputDiagnostics = emptyWaterHeaterStatus().inputs;
    this.elementIssues = {};
  }

  /** Builds draft elements without changing this instance's cached readings. */
  previewElements(config: WaterHeaterConfig, entities: readonly HAEntity[] = [], connected = true): Element[] {
    const errors = validateWaterHeaterConfig(config);
    if (errors.length) throw new Error(errors[0]);
    // Unchanged bindings retain last-good values even while HA is unavailable.
    // update() clears only bindings changed by this isolated draft.
    const preview = new WaterHeater(this.config);
    preview.readings = { ...this.readings };
    preview.bindings = { ...this.bindings };
    preview.update(config, entities, connected);
    return preview.elements();
  }

  status(): WaterHeaterStatus {
    return WaterHeaterStatusSchema.parse({
      enabled: this.config.enabled,
      inputs: this.inputDiagnostics,
      ...(Object.keys(this.elementIssues).length ? { elementIssues: { ...this.elementIssues } } : {}),
      ...(this.diagnostic ? { error: this.diagnostic } : {})
    });
  }

  elements(): Element[] {
    return [
      {
        id: "water.remaining",
        label: "Water remaining",
        height: 1,
        minWidth: 6,
        render: (width) => [this.remainingRow(width)]
      },
      {
        id: "water.temperature-text",
        label: "Water temperature text",
        height: 1,
        minWidth: 8,
        render: (width) => [this.temperatureTextRow(width)]
      },
      {
        id: "water.emv-position",
        label: "Water EMV position",
        height: 1,
        minWidth: 6,
        render: (width) => [this.emvPositionRow(width)]
      }
    ];
  }

  private remainingRow(width: number): number[] {
    if (!this.config.enabled) return blankRow(width);
    const remaining = this.readings.remaining;
    const capacity = this.readings.capacity;
    if (remaining === undefined || capacity === undefined || capacity <= 0) return textRow("N/A", width);
    const label = this.config.remainingLabel;
    if (width < label.length + 1 + 2) return textRow("N/A", width);

    const gallons = displayGallons(remaining, width, label.length);
    const barWidth = Math.max(1, width - label.length - gallons.length);
    return [
      ...encode(label),
      ...barRow(Math.max(0, Math.min(1, remaining / capacity)), barWidth, this.config.barCharacter),
      ...encode(gallons)
    ];
  }

  private temperatureTextRow(width: number): number[] {
    if (!this.config.enabled) return blankRow(width);
    const temperature = this.readings.temperature;
    const target = this.readings.target;
    if (temperature === undefined || target === undefined) return textRow("N/A", width);
    const prefix = encode(displayNumber(temperature));
    const separator = this.readings.heating === true ? this.config.heatingCharacter : encode("/")[0]!;
    const suffix = encode(`${displayNumber(target)}${this.config.unit}`);
    const row = [...prefix, separator, ...suffix];
    return row.length <= width ? [...row, ...Array(width - row.length).fill(BLANK)] : textRow("OVERFLOW", width);
  }

  private emvPositionRow(width: number): number[] {
    if (!this.config.enabled) return blankRow(width);
    const value = this.readings.emvPosition;
    const label = this.config.emvLabel;
    if (value === undefined) return textRow(`${label} N/A`, width);
    const text = `${label}${displayNumber(value)}`;
    return text.length <= width
      ? textRow(text, width)
      : textRow(`${label}${"?".repeat(Math.max(0, width - label.length))}`, width);
  }
}

export function createWaterHeaterIntegration(config: WaterHeaterConfig, source: Pick<HomeAssistantService, "snapshot" | "subscribe">, changed: () => void, logger: Pick<Console, "info" | "warn"> = console) {
  let current = config;
  const heater = createWaterHeater(config);
  let identity = source.snapshot().source;
  const lastInputDiagnostics = new Map<string, string>();
  let lastElementDiagnostic: string | undefined;
  const observe = (): void => {
    const status = heater.status();
    for (const [field, input] of Object.entries(status.inputs)) {
      const diagnostic = input.error ? `${input.error}${input.retained ? " (retained last-good value)" : ""}` : undefined;
      const previous = lastInputDiagnostics.get(field);
      if (diagnostic && diagnostic !== previous) logger.warn(`Water input diagnostic (${field}): ${diagnostic}`);
      if (!diagnostic && previous) logger.info(`Water input diagnostic recovered (${field}).`);
      if (diagnostic) lastInputDiagnostics.set(field, diagnostic); else lastInputDiagnostics.delete(field);
    }
    const elementDiagnostic = status.error && Object.keys(status.inputs).every((field) => !status.inputs[field as keyof typeof status.inputs].error)
      ? status.error : undefined;
    if (elementDiagnostic && elementDiagnostic !== lastElementDiagnostic) logger.warn(`Water element diagnostic: ${elementDiagnostic}`);
    if (!elementDiagnostic && lastElementDiagnostic) logger.info("Water element diagnostics recovered.");
    lastElementDiagnostic = elementDiagnostic;
  };
  const update = () => {
    const snapshot = source.snapshot();
    if (identity !== snapshot.source) {
      identity = snapshot.source;
      heater.resetSource(current);
    }
    heater.update(current, snapshot.entities, snapshot.connected);
    observe();
    changed();
  };
  const unsubscribe = source.subscribe(update);
  const initialSnapshot = source.snapshot();
  heater.update(current, initialSnapshot.entities, initialSnapshot.connected);
  observe();
  return {
    id: "water-heater", slug: "water",
    get enabled() { return current.enabled; },
    configure(value: WaterHeaterConfig) { current = value; update(); },
    elements(draft = current) {
      const snapshot = source.snapshot();
      return heater.previewElements(draft, snapshot.entities, snapshot.connected);
    },
    status: () => heater.status(),
    stop() { unsubscribe(); }
  };
}

export function createWaterHeater(config: WaterHeaterConfig = DEFAULT_WATER_HEATER_CONFIG): WaterHeater {
  return new WaterHeater(config);
}

function isEntityInput(input: Exclude<Input, null>): input is Exclude<Input, null> & { entityId: string; attribute?: string } {
  return typeof input === "object" && "entityId" in input;
}

function connectionError(input: { entityId: string; attribute?: string }): string {
  const source = input.attribute ? `${input.entityId}.${input.attribute}` : input.entityId;
  return `${source} is unavailable (Home Assistant connection is disconnected).`;
}

function resolveInput(input: Exclude<Input, null>, entities: Map<string, HAEntity>): { value?: number; error?: string } {
  if (!input || typeof input !== "object") return { error: "input is invalid." };
  if ("constant" in input) return { value: input.constant };
  if (!("entityId" in input) || typeof input.entityId !== "string") return { error: "source entity is invalid." };
  const entity = entities.get(input.entityId);
  const source = input.attribute ? `${input.entityId}.${input.attribute}` : input.entityId;
  if (!entity) return { error: `${source} is unavailable (entity not found).` };
  if (!input.attribute && (entity.state === "unknown" || entity.state === "unavailable")) return { error: `${source} is unavailable (state is ${entity.state}).` };
  const value = input.attribute ? entity.attributes[input.attribute] : entity.state;
  const number = numeric(value);
  return number === undefined ? { error: `${source} is unavailable (value is not numeric).` } : { value: number };
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validReading(field: keyof WaterReadings, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (field === "remaining") return value >= 0;
  if (field === "capacity") return value > 0;
  return true;
}

function readingError(field: keyof WaterReadings, value: number | undefined): string {
  if (field === "remaining" && value !== undefined && value < 0) return "remaining must be non-negative.";
  if (field === "capacity" && value !== undefined && value <= 0) return "capacity must be positive.";
  return `${field} reading is unavailable.`;
}

function inputBinding(field: string, input: Input): string {
  return JSON.stringify([field, input]);
}

function cloneConfig(config: WaterHeaterConfig): WaterHeaterConfig {
  return {
    ...DEFAULT_WATER_HEATER_CONFIG,
    ...config,
    remaining: config.remaining ? { ...config.remaining } : null,
    capacity: config.capacity ? { ...config.capacity } : null,
    temperature: config.temperature ? { ...config.temperature } : null,
    target: config.target ? { ...config.target } : null,
    emvPosition: config.emvPosition ? { ...config.emvPosition } : null,
    heating: config.heating ? { ...config.heating } : null
  };
}

function buildInputDiagnostics(config: WaterHeaterConfig, readings: WaterReadings, configErrors: readonly string[]): WaterHeaterStatus["inputs"] {
  const inputs = {} as WaterHeaterStatus["inputs"];
  for (const field of ["remaining", "capacity", "temperature", "target", "emvPosition", "heating"] as const) {
    const input = config[field] ?? null;
    inputs[field] = {
      configured: input !== null,
      ...(readings[field] !== undefined ? { value: readings[field] } : {}),
      ...(configErrors.find((error) => error.startsWith(`${field}.`) || error.startsWith(`${field} `)) ? { error: configErrors.find((error) => error.startsWith(`${field}.`) || error.startsWith(`${field} `)) } : {})
    };
  }
  return inputs;
}

function resolveHeatingInput(input: Exclude<NonNullable<WaterHeaterConfig["heating"]>, null>, entities: Map<string, HAEntity>): { value?: boolean; error?: string } {
  const source = input.attribute ? `${input.entityId}.${input.attribute}` : input.entityId;
  const entity = entities.get(input.entityId);
  if (!entity) return { error: `${source} is unavailable (entity not found).` };
  const raw = input.attribute ? entity.attributes[input.attribute] : entity.state;
  if (typeof raw !== "string" && typeof raw !== "boolean" && typeof raw !== "number") return { error: `${source} is unavailable (state is not boolean).` };
  const value = String(raw).trim().toLowerCase();
  if (["on", "true", "1"].includes(value)) return { value: true };
  if (["off", "false", "0"].includes(value)) return { value: false };
  return { error: `${source} is unavailable (state is not on/off).` };
}

function barRow(ratio: number, width: number, fill: number): number[] {
  const filled = Math.ceil(ratio * width);
  return [...Array(filled).fill(fill), ...Array(width - filled).fill(BLANK)];
}

function textRow(text: string, width: number): number[] {
  return [...encode(text.slice(0, width)), ...Array(Math.max(0, width - text.length)).fill(BLANK)];
}

function blankRow(width: number): number[] {
  return Array(Math.max(0, width)).fill(BLANK);
}

function displayNumber(value: number): string {
  return String(Math.round(value));
}

function displayGallons(value: number, width: number, labelLength: number): string {
  // Reserve one bar cell so unusually large readings cannot push the unit off
  // the board while retaining the same compact suffix at normal board widths.
  const maxDigits = Math.max(1, width - labelLength - 2);
  const maxGallons = maxDigits >= 16 ? Number.MAX_SAFE_INTEGER : (10 ** maxDigits) - 1;
  return `${Math.min(Math.round(Math.max(0, value)), maxGallons)}G`;
}
