import type {
  AppConfig,
  ConfigResponse,
  ElementsResponse,
  LayoutEntry,
  LoginStatus,
  PreviewResponse,
  BoardKind,
  RuntimeStatus
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body || init?.method === "POST" ? { "Content-Type": "application/json" } : {}),
      ...init?.headers
    }
  });

  const payload = await response.json().catch(() => undefined) as { error?: string } | T | undefined;
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
      ? payload.error
      : `Request failed (${response.status}).`;
    throw new ApiError(response.status, message);
  }

  return payload as T;
}

export function getConfig(): Promise<ConfigResponse> {
  return request<ConfigResponse>("/api/config");
}

export function getElements(): Promise<ElementsResponse> {
  return request<ElementsResponse>("/api/elements");
}

export function getStatus(): Promise<RuntimeStatus> {
  return request<RuntimeStatus>("/api/status");
}

export function requestPreview(layout: LayoutEntry[], board: BoardKind | "auto", water?: unknown): Promise<PreviewResponse> {
  return request<PreviewResponse>("/api/preview", {
    method: "POST",
    body: JSON.stringify({ layout, board, ...(water !== undefined ? { water } : {}) })
  });
}

export function saveConfig(config: AppConfig): Promise<ConfigResponse> {
  return request<ConfigResponse>("/api/config", {
    method: "POST",
    body: JSON.stringify(config)
  });
}

export function setPause(paused: boolean): Promise<{ paused: boolean }> {
  return request<{ paused: boolean }>("/api/pause", {
    method: "POST",
    body: JSON.stringify({ paused })
  });
}

export function startLogin(): Promise<LoginStatus> {
  return request<LoginStatus>("/api/login/start", { method: "POST", body: JSON.stringify({}) });
}

export function cancelLogin(): Promise<LoginStatus> {
  return request<LoginStatus>("/api/login/cancel", { method: "POST", body: JSON.stringify({}) });
}

export function checkLogin(): Promise<LoginStatus> {
  return request<LoginStatus>("/api/login/check", { method: "POST", body: JSON.stringify({}) });
}

export function subscribeToEvents(onStatus: (status: RuntimeStatus) => void, onState: (connected: boolean, error?: string) => void): () => void {
  const source = new EventSource(`${API_BASE}/api/events`);
  source.onopen = () => onState(true);
  source.onmessage = (event) => {
    try {
      onStatus(JSON.parse(event.data) as RuntimeStatus);
    } catch {
      onState(false, "The live update contained invalid data.");
    }
  };
  source.onerror = () => onState(false, "Live updates are unavailable. The last reading is still shown.");
  return () => source.close();
}
