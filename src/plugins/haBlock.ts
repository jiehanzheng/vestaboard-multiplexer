import type { HABlockStatus } from "./haBlock/status.js";
import type { Element } from "../elements.js";
import type { HomeAssistantServiceLike, HomeAssistantSnapshot } from "../homeAssistantService.js";
import { encode, isValidCharacterCode } from "../vestaboardCharacters.js";
import { HA_BLOCK_ELEMENT_ID, HABlockConfigSchema, HABlocksSchema, haBlockElementId, haBlockGeometry, type HABlockConfig, type HABlockInstance } from "./haBlock/config.js";

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


function blockElement(config: HABlockConfig, snapshot: HomeAssistantSnapshot, id = HA_BLOCK_ELEMENT_ID, label = "HA character block"): Element {
  const value = HABlockConfigSchema.parse(config);
  const result = resolve(value, snapshot);
  // Playback badges must not claim a retained play state during an outage.
  // Staleness measures the failure's duration; it never ages healthy paused content.
  const codes = result.characters ?? (result.error && value.unavailableDisplay === "na" ? encode("N/A") : []);
  return { id, label, ...haBlockGeometry(value), render(width) {
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
    if (config.entityId !== this.config.entityId || config.attribute !== this.config.attribute) this.unavailableSince = undefined;
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
    const { error } = resolve(this.config, snapshot);
    return { enabled: this.config.enabled, ...(error ? { error } : {}),
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
  const configure = (blocks: HABlockInstance[]): void => {
    const snapshot = source.snapshot();
    const next = HABlocksSchema.parse(blocks);
    const ids = new Set(next.map((block) => block.id));
    for (const id of diagnostics.keys()) if (!ids.has(id)) diagnostics.delete(id);
    for (const block of next) {
      let state = diagnostics.get(block.id);
      if (!state) { state = new BlockDiagnostics(settings(block), block.id, logger, now); diagnostics.set(block.id, state); }
      state.configure(settings(block), snapshot);
    }
    current = next;
  };
  configure(current);
  // A single HA event updates all instances before composition, avoiding one full render per block.
  const unsubscribe = source.subscribe((snapshot) => {
    for (const state of diagnostics.values()) state.update(snapshot);
    changed();
  });
  return {
    id: "ha-character-blocks", slug: "haBlocks",
    get enabled() { return current.some((block) => block.enabled); },
    configure(blocks: HABlockInstance[]) { configure(blocks); changed(); },
    status(): Record<string, HABlockStatus> {
      const snapshot = source.snapshot();
      return Object.fromEntries([...diagnostics].map(([id, state]) => [id, state.status(snapshot)]));
    },
    elements(draft = current): Element[] {
      const snapshot = source.snapshot();
      return HABlocksSchema.parse(draft).map((block) => blockElement(settings(block), snapshot, haBlockElementId(block.id), block.name));
    },
    stop() { unsubscribe(); }
  };
}

export function createHABlockIntegration(
  config: HABlockConfig, source: Pick<HomeAssistantServiceLike, "snapshot" | "subscribe">,
  changed: () => void, logger: Pick<Console, "info" | "warn"> = console, now: () => Date = () => new Date()
) {
  let current = config;
  const state = new BlockDiagnostics(config, "characters", logger, now);
  const update = () => { state.update(source.snapshot()); changed(); };
  const unsubscribe = source.subscribe(update);
  update();
  return {
    configure(value: HABlockConfig) { current = value; state.configure(value, source.snapshot()); changed(); },
    status: () => state.status(source.snapshot()),
    elements: (draft = current): Element[] => [blockElement(draft, source.snapshot())],
    stop() { unsubscribe(); }
  };
}
