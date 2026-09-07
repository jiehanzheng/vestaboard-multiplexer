import {
  ConfigResponseSchema,
  ElementsResponseSchema,
  LoginStatusSchema,
  PreviewResponseSchema,
  RuntimeEventSchema,
  RuntimeStatusSchema,
  type ElementsResponse,
  type LoginStatus,
  type PreviewResponse,
  type RuntimeStatus
} from "../../src/contracts/api";
import { HAConnectionTestResponseSchema, HAEntitiesResponseSchema, type HAConnectionTestRequest, type HAConnectionTestResponse, type HAEntitiesRequest, type HAEntitiesResponse } from "../../src/contracts/homeAssistant";
import { ConfigSaveResponseSchema, type AppConfig, type ConfigPatch, type ConfigSaveResponse, type LayoutEntry, type PublicConfig, type WaterHeaterConfig } from "../../src/contracts/config";
import { LogsResponseSchema, type LogsResponse } from "../../src/contracts/logs.js";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

type Parser<T> = { parse: (value: unknown) => T };

async function request<T>(path: string, parser: Parser<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body || init?.method === "POST" ? { "Content-Type": "application/json" } : {}),
      ...init?.headers
    }
  });

  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : `Request failed (${response.status}).`;
    throw new ApiError(response.status, message);
  }
  try {
    return parser.parse(payload);
  } catch {
    throw new ApiError(502, "The server returned an invalid response.");
  }
}

export function getConfig(): Promise<PublicConfig> {
  return request("/api/config", ConfigResponseSchema);
}

export function getElements(): Promise<ElementsResponse> {
  return request("/api/elements", ElementsResponseSchema);
}

export function getStatus(): Promise<RuntimeStatus> {
  return request("/api/status", RuntimeStatusSchema);
}

export function getLogs(): Promise<LogsResponse> {
  return request("/api/logs", LogsResponseSchema);
}

export function requestPreview(layout: LayoutEntry[], board: AppConfig["board"], water?: WaterHeaterConfig, codex?: AppConfig["codex"]): Promise<PreviewResponse> {
  return request("/api/preview", PreviewResponseSchema, {
    method: "POST",
    body: JSON.stringify({ layout, board, ...(water !== undefined ? { water } : {}), ...(codex !== undefined ? { codex } : {}) })
  });
}

export function saveConfig(config: ConfigPatch): Promise<ConfigSaveResponse> {
  return request("/api/config", ConfigSaveResponseSchema, {
    method: "POST",
    body: JSON.stringify(config)
  });
}

export function setPause(paused: boolean): Promise<RuntimeStatus> {
  return request("/api/pause", RuntimeStatusSchema, {
    method: "POST",
    body: JSON.stringify({ paused })
  });
}

export function startLogin(): Promise<LoginStatus> {
  return request("/api/login/start", LoginStatusSchema, { method: "POST", body: "{}" });
}

export function cancelLogin(): Promise<LoginStatus> {
  return request("/api/login/cancel", LoginStatusSchema, { method: "POST", body: "{}" });
}

export function checkLogin(): Promise<LoginStatus> {
  return request("/api/login/check", LoginStatusSchema, { method: "POST", body: "{}" });
}

export function testHomeAssistant(input: HAConnectionTestRequest): Promise<HAConnectionTestResponse> {
  return request("/api/ha/test", HAConnectionTestResponseSchema, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function getHomeAssistantEntities(input: HAEntitiesRequest): Promise<HAEntitiesResponse> {
  return request("/api/ha/entities", HAEntitiesResponseSchema, {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function subscribeToEvents(onStatus: (status: RuntimeStatus) => void, onState: (connected: boolean, error?: string) => void, onLogs?: (logs: LogsResponse) => void): () => void {
  const source = new EventSource(`${API_BASE}/api/events`);
  source.onopen = () => onState(true);
  source.onmessage = (event) => {
    try {
      const nextStatus = RuntimeEventSchema.parse(JSON.parse(event.data));
      onStatus(nextStatus);
      onState(true);
    } catch {
      onState(false, "The live update contained invalid data.");
    }
  };
  source.addEventListener("logs", (event) => {
    try {
      onLogs?.(LogsResponseSchema.parse(JSON.parse(event.data)));
    } catch {
      onState(false, "The live log update contained invalid data.");
    }
  });
  source.onerror = () => onState(false, "Live updates are unavailable. The last reading is still shown.");
  return () => source.close();
}
