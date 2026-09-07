import type { HAConfig } from "../../src/contracts/config.js";

/** Identifies URL and token intent, including omitted versus explicit empty. */
export function homeAssistantRequestKey(value: Pick<HAConfig, "url" | "token">): string {
  return JSON.stringify([value.url, value.token === undefined ? { state: "omitted" } : { state: "provided", value: value.token }]);
}
