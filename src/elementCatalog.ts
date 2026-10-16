import type { AppConfig } from "./contracts/config.js";
import { CODEX_ELEMENT_IDS } from "./plugins/codexQuota/elementIds.js";
import { haBlockElementId } from "./plugins/haBlock/config.js";
import { barRowElementId } from "./plugins/barRows/config.js";

/** Disabled configured content still owns its ID; only removed instances are unsupported. */
export function supportedElementIds(config: Pick<AppConfig, "haBlocks" | "barRows">): Set<string> {
  return new Set([...CODEX_ELEMENT_IDS, ...config.haBlocks.map((block) => haBlockElementId(block.id)), ...config.barRows.map((row) => barRowElementId(row.id))]);
}
