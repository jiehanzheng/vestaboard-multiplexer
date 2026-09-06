import type { Element } from "../elements.js";
import { BLANK, BLUE, encode, GREEN } from "./codexQuota/display/shared.js";
import type { HAEntity } from "../homeAssistant.js";

export type Input = { constant: number } | { entityId: string; attribute?: string } | null;

export interface WaterHeaterConfig {
  remaining: Input;
  capacity: Input;
  temperature: Input;
  target: Input;
  unit: "F" | "C";
  baseline?: number;
  enabled: boolean;
}

export interface WaterHeaterStatus {
  error?: string;
}

interface WaterReadings {
  remaining?: number;
  capacity?: number;
  temperature?: number;
  target?: number;
}

export const DEFAULT_WATER_HEATER_CONFIG: WaterHeaterConfig = {
  remaining: null,
  capacity: null,
  temperature: null,
  target: null,
  unit: "F",
  enabled: false
};

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
    this.config = nextConfig;
    this.diagnostic = errors[0];

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

export function createWaterHeater(config: WaterHeaterConfig = DEFAULT_WATER_HEATER_CONFIG): WaterHeater {
  return new WaterHeater(config);
}

export function validateWaterHeaterConfig(config: WaterHeaterConfig): string[] {
  const errors: string[] = [];
  if (config.unit !== "F" && config.unit !== "C") errors.push("unit must be F or C.");
  for (const field of ["remaining", "capacity", "temperature", "target"] as const) {
    const input = config[field];
    if (input === null) continue;
    if (typeof input !== "object" || Array.isArray(input)) {
      errors.push(`${field} must be a constant or entity source.`);
      continue;
    }
    if ("constant" in input) {
      const value = input.constant;
      if (!Number.isFinite(value) || (field === "remaining" && value < 0) || (field === "capacity" && value <= 0)) {
        errors.push(`${field} constant must be finite${field === "remaining" ? " and non-negative" : field === "capacity" ? " and positive" : ""}.`);
      }
      continue;
    }
    if ("entityId" in input) {
      if (typeof input.entityId !== "string" || !input.entityId.trim()) errors.push(`${field} entityId is required.`);
      if (input.attribute !== undefined && (typeof input.attribute !== "string" || !input.attribute.trim())) {
        errors.push(`${field} attribute must be a non-empty string.`);
      }
      continue;
    }
    errors.push(`${field} must be a constant or entity source.`);
  }
  if (config.baseline !== undefined && !Number.isFinite(config.baseline)) {
    errors.push("baseline must be a finite number.");
  }
  return errors;
}

function resolveInput(input: Exclude<Input, null>, entities: Map<string, HAEntity>): number | undefined {
  if ("constant" in input) return input.constant;
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
  if (input === null) return `${field}:none`;
  return "constant" in input
    ? `${field}:constant:${input.constant}`
    : `${field}:entity:${input.entityId}:${input.attribute ?? ""}`;
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
