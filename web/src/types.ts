export type BoardKind = "note" | "flagship";
export type BoardPreference = "auto" | BoardKind;
export type PreviewMode = "desired" | "lastSent";

export interface BoardMessage {
  text: string;
  characters: number[][];
}

export interface RuntimeStatus {
  board: BoardKind;
  desired?: BoardMessage;
  lastSent?: BoardMessage;
  nextAttemptAt: number;
  lastSentAt?: number;
  manualPause: boolean;
  haPause: boolean;
  paused: boolean;
  deliveryError?: string;
  configError?: string;
  codex: {
    error?: string;
    collectedAt?: string;
  };
  homeAssistant?: {
    connected: boolean;
    error?: string;
  };
  water?: {
    error?: string;
  };
  login: LoginStatus;
}

export interface LoginStatus {
  pending: boolean;
  account?: string;
  error?: string;
  userCode?: string;
  verificationUrl?: string;
}

export interface BoardElement {
  id: string;
  label: string;
  height: number;
  preview: number[][];
}

export interface LayoutEntry {
  elementId: string;
  startRow: number;
}

export interface ElementsResponse {
  elements: BoardElement[];
  defaultLayout?: LayoutEntry[];
}

export type ConfigValue = string | number | boolean | null | ConfigObject | unknown[];
export interface ConfigObject {
  [key: string]: ConfigValue | undefined;
}

export interface AppConfig {
  [key: string]: ConfigValue | undefined;
}

export interface ConfigResponse {
  config: AppConfig;
  locked: string[];
  hasSecrets: {
    token: boolean;
    localApiKey: boolean;
    haToken?: boolean;
  };
  error?: string;
}

export interface PreviewResponse extends BoardMessage {}

export interface EventConnectionState {
  connected: boolean;
  error?: string;
}

export interface FieldOption {
  value: string;
  label: string;
}
