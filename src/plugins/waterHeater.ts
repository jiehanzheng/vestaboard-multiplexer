import type { Element } from "../elements.js";
import { BLANK, BLUE, encode, GREEN } from "../vestaboardCharacters.js";
import type { HAEntity } from "../contracts/homeAssistant.js";
import type { HomeAssistantService } from "../homeAssistantService.js";
import {
  DEFAULT_WATER_HEATER_CONFIG,
  validateWaterHeaterConfig,
  type Input,
  type WaterHeaterConfig
} from "./waterHeater/config.js";

export {
  ConstantInputSchema,
  DEFAULT_WATER_HEATER_CONFIG,
  EntityInputSchema,
  InputSchema,
  validateWaterHeaterConfig,
  WaterHeaterConfigBaseSchema,
  WaterHeaterConfigSchema,
  waterHeaterLayoutIssues
} from "./waterHeater/config.js";
export type { ConstantInput, EntityInput, Input, WaterHeaterConfig } from "./waterHeater/config.js";


export interface WaterHeaterStatus {
  error?: string;
}

interface WaterReadings {
  remaining?: number;
  capacity?: number;
  temperature?: number;
  target?: number;
}

export class WaterHeater {
  private config: WaterHeaterConfig;
  private readings: WaterReadings = {};
  private bindings: Record<keyof WaterReadings, string> = {
    remaining: "remaining:none",
    capacity: "capacity:none",
    temperature: "temperature:none",
    target: "target:none"
  };
  private diagnostic: string | undefined;

  constructor(config: WaterHeaterConfig = DEFAULT_WATER_HEATER_CONFIG) {
    this.config = cloneConfig(config);
  }

  update(config: WaterHeaterConfig, entities: readonly HAEntity[] = []): WaterHeaterStatus {
    const nextConfig = cloneConfig(config);
    const errors = validateWaterHeaterConfig(nextConfig);
    this.config = errors.length ? cloneConfig({ ...DEFAULT_WATER_HEATER_CONFIG, enabled: false }) : nextConfig;
    this.diagnostic = errors[0];
    if (errors.length) return this.status();

    const entityMap = new Map(entities.map((entity) => [entity.entity_id, entity]));
    for (const field of ["remaining", "capacity", "temperature", "target"] as const) {
      const input = nextConfig[field];
      const binding = inputBinding(field, input);
      if (this.bindings[field] !== binding) {
        this.bindings[field] = binding;
        delete this.readings[field];
      }
      if (!nextConfig.enabled || input === null) continue;

      const value = resolveInput(input, entityMap);
      if (value === undefined || !validReading(field, value)) {
        this.diagnostic ??= `${field} reading is unavailable.`;
        continue;
      }
      this.readings[field] = value;
    }

    if (nextConfig.enabled && nextConfig.baseline !== undefined && !Number.isFinite(nextConfig.baseline)) {
      this.diagnostic ??= "baseline must be a finite number.";
    }
    if (nextConfig.enabled && nextConfig.baseline !== undefined && this.readings.target !== undefined && this.readings.target <= nextConfig.baseline) {
      this.diagnostic ??= "baseline must be below target.";
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
      target: "target:none"
    };
    this.diagnostic = undefined;
  }

  /** Builds draft elements without changing this instance's cached readings. */
  previewElements(config: WaterHeaterConfig, entities: readonly HAEntity[] = []): Element[] {
    const errors = validateWaterHeaterConfig(config);
    if (errors.length) throw new Error(errors[0]);
    // Unchanged bindings retain last-good values even while HA is unavailable.
    // update() clears only bindings changed by this isolated draft.
    const preview = new WaterHeater(this.config);
    preview.readings = { ...this.readings };
    preview.bindings = { ...this.bindings };
    preview.update(config, entities);
    return preview.elements();
  }

  status(): WaterHeaterStatus {
    return this.diagnostic ? { error: this.diagnostic } : {};
  }

  elements(): Element[] {
    return [
      {
        id: "water.remaining",
        label: "Water remaining",
        height: 1,
        render: (width) => [this.remainingRow(width)]
      },
      {
        id: "water.temperature-bar",
        label: "Water temperature",
        height: 1,
        render: (width) => [this.temperatureBarRow(width)]
      },
      {
        id: "water.temperature-text",
        label: "Water temperature text",
        height: 1,
        render: (width) => [this.temperatureTextRow(width)]
      }
    ];
  }

  private remainingRow(width: number): number[] {
    if (!this.config.enabled) return blankRow(width);
    const remaining = this.readings.remaining;
    const capacity = this.readings.capacity;
    if (remaining === undefined || capacity === undefined || capacity <= 0) return textRow("N/A", width);
    return barRow(Math.max(0, Math.min(1, remaining / capacity)), width, GREEN);
  }

  private temperatureBarRow(width: number): number[] {
    if (!this.config.enabled) return blankRow(width);
    const temperature = this.readings.temperature;
    const target = this.readings.target;
    const baseline = this.config.baseline;
    if (temperature === undefined || target === undefined || baseline === undefined || target <= baseline) {
      return textRow("N/A", width);
    }
    return barRow(Math.max(0, Math.min(1, (temperature - baseline) / (target - baseline))), width, BLUE);
  }

  private temperatureTextRow(width: number): number[] {
    if (!this.config.enabled) return blankRow(width);
    const temperature = this.readings.temperature;
    const target = this.readings.target;
    if (temperature === undefined || target === undefined) return textRow("N/A", width);
    return textRow(`${displayNumber(temperature)}/${displayNumber(target)}${this.config.unit}`, width);
  }
}

export function createWaterHeaterIntegration(config: WaterHeaterConfig, source: Pick<HomeAssistantService, "snapshot" | "subscribe">, changed: () => void) {
  let current = config;
  const heater = createWaterHeater(config);
  let identity = source.snapshot().source;
  const update = () => {
    const snapshot = source.snapshot();
    if (identity !== snapshot.source) {
      identity = snapshot.source;
      heater.resetSource(current);
    }
    heater.update(current, snapshot.entities);
    changed();
  };
  const unsubscribe = source.subscribe(update);
  heater.update(current, source.snapshot().entities);
  return {
    id: "water-heater", slug: "water",
    get enabled() { return current.enabled; },
    configure(value: WaterHeaterConfig) { current = value; update(); },
    elements(draft = current) { return heater.previewElements(draft, source.snapshot().entities); },
    status: () => heater.status(),
    stop() { unsubscribe(); }
  };
}

export function createWaterHeater(config: WaterHeaterConfig = DEFAULT_WATER_HEATER_CONFIG): WaterHeater {
  return new WaterHeater(config);
}

function resolveInput(input: Exclude<Input, null>, entities: Map<string, HAEntity>): number | undefined {
  if (!input || typeof input !== "object") return undefined;
  if ("constant" in input) return input.constant;
  if (!("entityId" in input) || typeof input.entityId !== "string") return undefined;
  const entity = entities.get(input.entityId);
  if (!entity) return undefined;
  if (!input.attribute && (entity.state === "unknown" || entity.state === "unavailable")) return undefined;
  const value = input.attribute ? entity.attributes[input.attribute] : entity.state;
  return numeric(value);
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

function inputBinding(field: string, input: Input): string {
  return JSON.stringify([field, input]);
}

function cloneConfig(config: WaterHeaterConfig): WaterHeaterConfig {
  return {
    ...config,
    remaining: config.remaining ? { ...config.remaining } : null,
    capacity: config.capacity ? { ...config.capacity } : null,
    temperature: config.temperature ? { ...config.temperature } : null,
    target: config.target ? { ...config.target } : null
  };
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
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(1)));
}
