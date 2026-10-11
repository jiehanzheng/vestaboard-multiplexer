import type { HABlockStatus } from "./haBlock/status.js";
import type { Element } from "../elements.js";
import type { HomeAssistantServiceLike, HomeAssistantSnapshot } from "../homeAssistantService.js";
import { encode, isValidCharacterCode } from "../vestaboardCharacters.js";
import { HA_BLOCK_ELEMENT_ID, HABlockConfigSchema, haBlockGeometry, type HABlockConfig } from "./haBlock/config.js";

function resolve(config: HABlockConfig, snapshot: HomeAssistantSnapshot): { characters?: number[]; error?: string } {
  if (!config.enabled) return {};
  if (!snapshot.connected) return { error: "Home Assistant is disconnected." };
  const entity = snapshot.entities.find((value) => value.entity_id === config.entityId);
  if (!entity) return { error: "The selected entity is missing." };
  if (entity.attributes.restored || entity.state !== "ready") return { error: "The selected entity is not ready." };
  const value = entity.attributes[config.attribute];
  if (!Array.isArray(value) || !value.length || !value.every((code) => typeof code === "number" && isValidCharacterCode(code))) {
    return { error: "The selected attribute must be a nonempty array of supported integer character codes." };
  }
  if (value.length > config.width * config.height) return { error: "Character codes exceed the configured block capacity." };
  return { characters: value };
}

export function createHABlockIntegration(
  config: HABlockConfig, source: Pick<HomeAssistantServiceLike, "snapshot" | "subscribe">,
  changed: () => void, logger: Pick<Console, "info" | "warn"> = console, now: () => Date = () => new Date()
) {
  let current = config;
  let identity = source.snapshot().source;
  let unavailableSince: number | undefined;
  let previousError: string | undefined;
  const update = () => {
    const snapshot = source.snapshot();
    if (identity !== snapshot.source) { identity = snapshot.source; unavailableSince = undefined; }
    const { error } = resolve(current, snapshot);
    if (error) unavailableSince ??= now().getTime(); else unavailableSince = undefined;
    if (error && error !== previousError) logger.warn(`HA character block: ${error}`);
    if (!error && previousError) logger.info("HA character block recovered.");
    previousError = error;
    changed();
  };
  const unsubscribe = source.subscribe(update);
  update();
  return {
    id: "ha-character-block", slug: "haBlock",
    get enabled() { return current.enabled; },
    configure(value: HABlockConfig) {
      if (value.entityId !== current.entityId || value.attribute !== current.attribute) unavailableSince = undefined;
      current = value;
      update();
    },
    status(): HABlockStatus {
      const { error } = resolve(current, source.snapshot());
      return { enabled: current.enabled, ...(error ? { error } : {}),
        ...(unavailableSince === undefined ? {} : { unavailableSince: new Date(unavailableSince).toISOString() }),
        stale: Boolean(error && unavailableSince !== undefined && current.staleAfterMinutes !== null && now().getTime() - unavailableSince >= current.staleAfterMinutes * 60_000) };
    },
    elements(draft = current): Element[] {
      const value = HABlockConfigSchema.parse(draft);
      const result = resolve(value, source.snapshot());
      // Playback badges must not claim a retained play state during an outage.
      // Staleness measures the failure's duration; it never ages healthy paused content.
      const codes = result.characters ?? (result.error && value.unavailableDisplay === "na" ? encode("N/A") : []);
      return [{ id: HA_BLOCK_ELEMENT_ID, label: "HA character block", ...haBlockGeometry(value), render(width) {
        if (width < value.width) throw new Error(`HA character block requires at least ${value.width} columns.`);
        // Extra placement columns are margin; they must not change payload wrapping.
        return Array.from({ length: value.height }, (_, row) => Array.from({ length: width }, (_, column) =>
          column < value.width ? codes[row * value.width + column] ?? 0 : 0));
      } }];
    },
    stop() { unsubscribe(); }
  };
}
