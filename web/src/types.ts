import type { AppConfig, LayoutEntry, PublicConfig, HAConfig, WaterHeaterConfig } from "../../src/contracts/config";
import type {
  BoardMessage,
  ElementsResponse,
  LoginStatus,
  PreviewResponse,
  RuntimeStatus
} from "../../src/contracts/api";
import type { HAEntity } from "../../src/contracts/homeAssistant";

export type BoardKind = "note" | "flagship";
export type BoardPreference = "auto" | BoardKind;
export type PreviewMode = "desired" | "lastSent";

export type {
  AppConfig,
  BoardMessage,
  ElementsResponse,
  HAConfig,
  HAEntity,
  LayoutEntry,
  LoginStatus,
  PreviewResponse,
  RuntimeStatus,
  WaterHeaterConfig
};

export type ConfigResponse = PublicConfig;
export type BoardElement = ElementsResponse["elements"][number];

export interface EventConnectionState {
  connected: boolean;
  error?: string;
}

export interface EntityCatalogState {
  items: HAEntity[];
  loading: boolean;
  loadedAt?: number;
  error?: string;
}

export interface FieldOption {
  value: string;
  label: string;
}
