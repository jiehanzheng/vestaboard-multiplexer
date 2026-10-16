import test from "node:test";
import assert from "node:assert/strict";
import { supportedElementIds } from "../src/elementCatalog.js";
import { createCodexElements } from "../src/plugins/codexQuota/elements.js";
import { DEFAULT_APP_CONFIG } from "../src/config.js";
import { BarRowConfigSchema } from "../src/plugins/barRows/config.js";
import { DEFAULT_HA_BLOCK_CONFIG } from "../src/plugins/haBlock/config.js";

test("saved placement allowlist matches actual Codex elements and includes disabled configured instances", () => {
  const config = structuredClone(DEFAULT_APP_CONFIG);
  config.barRows = [BarRowConfigSchema.parse({ id: "disabled", name: "Disabled", enabled: false, source: { kind: "entity", entityId: "" } })];
  config.haBlocks = [{ ...DEFAULT_HA_BLOCK_CONFIG, id: "disabled", name: "Disabled" }];
  const ids = supportedElementIds(config);
  const codex = createCodexElements(() => { throw new Error("Catalog discovery must not collect or render."); });
  assert.deepEqual([...ids].sort(), [...codex.map((element) => element.id), "bar-row.disabled", "ha-block.disabled"].sort());
  assert.equal(ids.has("bar-row.missing"), false);
  assert.equal(ids.has("future-plugin.status"), false);
});
