import type { HAConfig, HAEntity } from "./contracts/homeAssistant.js";

/** The binding includes the source URL so a changed source cannot inherit old state. */
export function haPauseBinding(config: HAConfig): string | undefined {
  const pause = config.pause;
  if (!pause) return undefined;
  return JSON.stringify([config.url, pause.entityId, pause.pauseValue, pause.resumeValue]);
}

/** Interpret only exact configured states; unavailable HA data leaves the last result intact. */
export function readHAPause(config: HAConfig, entities: readonly HAEntity[]): boolean | undefined {
  const pause = config.pause;
  if (!pause) return undefined;
  const entity = entities.find((candidate) => candidate.entity_id === pause.entityId);
  if (!entity || entity.state === "unknown" || entity.state === "unavailable") return undefined;
  if (entity.state === pause.pauseValue) return true;
  if (entity.state === pause.resumeValue) return false;
  return undefined;
}
