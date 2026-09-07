import assert from "node:assert/strict";
import test from "node:test";

import { AppConfigSchema, DEFAULT_APP_CONFIG, PublicConfigSchema } from "../src/config.js";
import { LayoutEntrySchema } from "../src/contracts/config.js";
import { HAConfigSchema } from "../src/contracts/homeAssistant.js";
import { BoardElementSchema, PreviewResponseSchema } from "../src/contracts/api.js";
import { WaterHeaterConfigSchema } from "../src/plugins/waterHeater/config.js";

test("board endpoints reject invalid protocols and embedded credentials", () => {
  for (const url of ["not-a-url", "file:///tmp/board", "https://user:secret@board.local/"]) {
    for (const field of ["cloudUrl", "localUrl"] as const) {
      const config = structuredClone(DEFAULT_APP_CONFIG);
      config.transport[field] = url;
      assert.equal(AppConfigSchema.safeParse(config).success, false);
    }
  }
});

test("browser-safe settings schemas reject malformed domain values", () => {
  assert.equal(HAConfigSchema.safeParse({
    url: "https://user:password@homeassistant.local",
    pause: null
  }).success, false);
  assert.equal(HAConfigSchema.safeParse({
    url: "",
    pause: { entityId: "input_boolean.pause", pauseValue: "on", resumeValue: "on" }
  }).success, false);
  assert.equal(WaterHeaterConfigSchema.safeParse({
    remaining: null,
    capacity: { constant: 0 },
    temperature: null,
    target: null,
    unit: "F",
    enabled: true
  }).success, false);
  assert.equal(WaterHeaterConfigSchema.safeParse({
    remaining: null,
    capacity: null,
    temperature: null,
    target: null,
    unit: "F",
    enabled: "false"
  }).success, false);
});

test("public configuration schema requires secrets to be omitted", () => {
  const config = structuredClone(DEFAULT_APP_CONFIG);
  config.transport.token = "board-secret";
  config.transport.localApiKey = "local-secret";
  config.ha.token = "ha-secret";
  assert.equal(AppConfigSchema.safeParse(config).success, true);
  const publicConfig = structuredClone(config);
  delete publicConfig.transport.token;
  delete publicConfig.transport.localApiKey;
  delete publicConfig.ha.token;
  const response = {
    config: publicConfig,
    legacyEnvironmentVariables: [],
    hasSecrets: { token: true, localApiKey: false, haToken: true }
  };
  assert.equal(PublicConfigSchema.safeParse(response).success, true);
  const parsed = PublicConfigSchema.parse(response);
  assert.equal("token" in parsed.config.transport, false);
  assert.equal("localApiKey" in parsed.config.transport, false);
  assert.equal("token" in parsed.config.ha, false);
  assert.equal(PublicConfigSchema.safeParse({ ...response, config }).success, true);
});

test("preview responses require a complete character matrix", () => {
  assert.equal(PreviewResponseSchema.safeParse({ text: "A" }).success, false);
  assert.equal(PreviewResponseSchema.safeParse({ text: "A", characters: [[1]] }).success, true);
});

test("partial layout fields and element minimum widths are validated", () => {
  assert.equal(LayoutEntrySchema.safeParse({ elementId: "water.remaining", startRow: 0 }).success, true);
  assert.equal(LayoutEntrySchema.safeParse({ elementId: "water.remaining", startRow: 0, startColumn: 2, width: 6 }).success, true);
  assert.equal(LayoutEntrySchema.safeParse({ elementId: "water.remaining", startRow: 0, width: 0 }).success, false);
  assert.equal(BoardElementSchema.safeParse({ id: "water.remaining", label: "Water", height: 1, minWidth: 6, preview: [[0, 0, 0, 0, 0, 0]] }).success, true);
  assert.equal(BoardElementSchema.safeParse({ id: "water.remaining", label: "Water", height: 1, preview: [[0]] }).success, false);
});
