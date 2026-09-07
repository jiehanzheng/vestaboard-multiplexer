import type { ConfigPatch, ConfigSaveResponse, PublicConfig } from "../contracts/config.js";
import type { HAEntitiesRequest } from "../contracts/homeAssistant.js";
import type { LogsResponse } from "../contracts/logs.js";
import type { HomeAssistantInspection } from "../homeAssistantService.js";
import type { ElementsResponse, PreviewRequest, PreviewResponse, RuntimeStatus } from "../contracts/api.js";

/** The runtime owns this seam so future transports cannot become dependencies of the engine. */
export interface RuntimeActions {
  status(): RuntimeStatus;
  config(): PublicConfig;
  elements(): ElementsResponse;
  preview(input: PreviewRequest): PreviewResponse;
  save(input: ConfigPatch): Promise<ConfigSaveResponse>;
  pause(input: { paused: boolean }): Promise<RuntimeStatus>;
  logs(): LogsResponse;
  subscribeLogs(listener: () => void): () => void;
  homeAssistant(action: "test" | "entities", input?: HAEntitiesRequest): Promise<HomeAssistantInspection>;
}
