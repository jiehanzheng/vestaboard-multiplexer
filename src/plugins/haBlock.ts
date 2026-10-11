import type { ElementState } from "../contracts/layout.js";
import type { HABlockStatus } from "./haBlock/status.js";
import type { Element } from "../elements.js";
import type { HomeAssistantServiceLike, HomeAssistantSnapshot } from "../homeAssistantService.js";
import { encode, encodeDisplayText, isValidCharacterCode } from "../vestaboardCharacters.js";
import { HA_BLOCK_ELEMENT_ID, HABlockConfigSchema, HABlocksSchema, haBlockElementId, haBlockGeometry, type HABlockConfig, type HABlockInstance, legacyHABlock } from "./haBlock/config.js";

function resolve(config: HABlockConfig, snapshot: HomeAssistantSnapshot): { state: ElementState; characters?: number[]; error?: string; textTruncated?: boolean } {
  if (!config.enabled) return { state: "inactive" };
  if (!snapshot.connected) return { state: "unavailable", error: "Home Assistant is disconnected." };
  const entity = snapshot.entities.find((value) => value.entity_id === config.entityId);
  if (!entity) return { state: "unavailable", error: "The selected entity is missing." };
  if (entity.attributes.restored || entity.state !== "ready") return { state: "unavailable", error: "The selected entity is not ready." };
  if (config.activityAttribute !== undefined) {
    const active = entity.attributes[config.activityAttribute];
    if (typeof active !== "boolean") return { state: "unavailable", error: "The activity attribute must be a boolean." };
    if (!active) return { state: "inactive" };
  }
  const value = entity.attributes[config.attribute];
  if (!Array.isArray(value) || !value.length || !value.every((code) => typeof code === "number" && isValidCharacterCode(code))) {
    return { state: "unavailable", error: "The selected attribute must be a nonempty array of supported integer character codes." };
  }
  if (value.length > config.width * config.height) return { state: "unavailable", error: "Character codes exceed the configured block capacity." };
  if (config.textAttribute === undefined) return { state: "active", characters: value };
  const textEntity = config.textEntityId ? snapshot.entities.find((value) => value.entity_id === config.textEntityId) : entity;
  if (!textEntity || textEntity.attributes.restored || ["unknown", "unavailable"].includes(textEntity.state)) return { state: "unavailable", error: "The text source is unavailable." };
  const text = textEntity.attributes[config.textAttribute];
  if (typeof text !== "string") return { state: "unavailable", error: "The text attribute must be a string." };
  const encoded = encodeDisplayText(text);
  const remaining = Math.max(0, config.width * config.height - value.length);
  return { state: "active", characters: encoded.length && remaining > 0 ? [...value, ...encoded.slice(0, remaining)] : value,
    textTruncated: encoded.length > remaining };

}


function blockElement(config: HABlockConfig, snapshot: HomeAssistantSnapshot, id = HA_BLOCK_ELEMENT_ID, label = "HA character block"): Element {
  const value = HABlockConfigSchema.parse(config);
  const result = resolve(value, snapshot);
  // Playback badges must not claim a retained play state during an outage.
  // Staleness measures the failure's duration; it never ages healthy paused content.
  const codes = result.characters ?? (result.error && value.unavailableDisplay === "na" ? encode("N/A") : []);
  return { id, label, state: result.state, ...haBlockGeometry(value), render(width) {
    if (width < value.width) throw new Error(`${label} requires at least ${value.width} columns.`);
    // Extra placement columns are margin; they must not change payload wrapping.
    return Array.from({ length: value.height }, (_, row) => Array.from({ length: width }, (_, column) =>
      column < value.width ? codes[row * value.width + column] ?? 0 : 0));
  } };
}

function settings(block: HABlockInstance): HABlockConfig {
  const { id: _id, name: _name, ...config } = block;
  return config;
}

class BlockDiagnostics {
  private identity: string | undefined;
  private unavailableSince: number | undefined;
  private previousError: string | undefined;
  constructor(private config: HABlockConfig, private readonly label: string,
    private readonly logger: Pick<Console, "info" | "warn">, private readonly now: () => Date) {}

  configure(config: HABlockConfig, snapshot: HomeAssistantSnapshot): void {
    if (config.entityId !== this.config.entityId || config.attribute !== this.config.attribute || config.activityAttribute !== this.config.activityAttribute || config.textAttribute !== this.config.textAttribute || config.textEntityId !== this.config.textEntityId) this.unavailableSince = undefined;
    this.config = config;
    this.update(snapshot);
  }
  update(snapshot: HomeAssistantSnapshot): void {
    if (this.identity !== snapshot.source) { this.identity = snapshot.source; this.unavailableSince = undefined; }
    const { error } = resolve(this.config, snapshot);
    if (error) this.unavailableSince ??= this.now().getTime(); else this.unavailableSince = undefined;
    if (error && error !== this.previousError) this.logger.warn(`HA character block (${this.label}): ${error}`);
    if (!error && this.previousError) this.logger.info(`HA character block (${this.label}) recovered.`);
    this.previousError = error;
  }
  status(snapshot: HomeAssistantSnapshot): HABlockStatus {
    const { error, state, textTruncated } = resolve(this.config, snapshot);
    return { state, ...(textTruncated === undefined ? {} : { textTruncated }), enabled: this.config.enabled, ...(error ? { error } : {}),
      ...(this.unavailableSince === undefined ? {} : { unavailableSince: new Date(this.unavailableSince).toISOString() }),
      stale: Boolean(error && this.unavailableSince !== undefined && this.config.staleAfterMinutes !== null && this.now().getTime() - this.unavailableSince >= this.config.staleAfterMinutes * 60_000) };
  }
}

export function createHABlocksIntegration(
  configs: HABlockInstance[], source: Pick<HomeAssistantServiceLike, "snapshot" | "subscribe">,
  changed: () => void, logger: Pick<Console, "info" | "warn"> = console, now: () => Date = () => new Date()
) {
  let current = HABlocksSchema.parse(configs);
  const diagnostics = new Map<string, BlockDiagnostics>();
  let snapshot = source.snapshot(haBlockEntityIds(current));
  let unsubscribe = () => {};
  let visible = "";
  const signature = () => JSON.stringify(current.map((block) => resolve(settings(block), snapshot)));
  const update = (value: HomeAssistantSnapshot) => {
    snapshot = value;
    for (const state of diagnostics.values()) state.update(snapshot);
    const next = signature();
    if (visible !== next) { visible = next; changed(); }
  };
  const configure = (blocks: HABlockInstance[]): void => {
    const next = HABlocksSchema.parse(blocks);
    unsubscribe();
    snapshot = source.snapshot(haBlockEntityIds(next));
    const ids = new Set(next.map((block) => block.id));
    for (const id of diagnostics.keys()) if (!ids.has(id)) diagnostics.delete(id);
    for (const block of next) {
      let state = diagnostics.get(block.id);
      if (!state) { state = new BlockDiagnostics(settings(block), block.id, logger, now); diagnostics.set(block.id, state); }
      state.configure(settings(block), snapshot);
    }
    current = next;
    visible = signature();
    unsubscribe = source.subscribe(haBlockEntityIds(current), update);
  };
  configure(current);
  return {
    id: "ha-character-blocks", slug: "haBlocks",
    get enabled() { return current.some((block) => block.enabled); },
    configure(blocks: HABlockInstance[]) { configure(blocks); changed(); },
    status(): Record<string, HABlockStatus> {
      return Object.fromEntries([...diagnostics].map(([id, state]) => [id, state.status(snapshot)]));
    },
    elements(draft = current, snapshot = source.snapshot(haBlockEntityIds(draft))): Element[] {
      return HABlocksSchema.parse(draft).map((block) => blockElement(settings(block), snapshot, haBlockElementId(block.id), block.name));
    },
    stop() { unsubscribe(); }
  };
}

export function createHABlockIntegration(
  config: HABlockConfig, source: Pick<HomeAssistantServiceLike, "snapshot" | "subscribe">,
  changed: () => void, logger: Pick<Console, "info" | "warn"> = console, now: () => Date = () => new Date()
) {
  const blocks = createHABlocksIntegration([legacyHABlock(config)], source, changed, logger, now);
  return {
    configure(value: HABlockConfig) { blocks.configure([legacyHABlock(value)]); },
    status: () => blocks.status().characters!,
    elements: (draft?: HABlockConfig): Element[] => blocks.elements(draft ? [legacyHABlock(draft)] : undefined),
    stop() { blocks.stop(); }
  };
}

export function haBlockEntityIds(blocks: readonly HABlockInstance[]): string[] {
  return [...new Set(blocks.filter((block) => block.enabled).flatMap((block) => [block.entityId, ...(block.textAttribute && block.textEntityId ? [block.textEntityId] : [])]))];
}
