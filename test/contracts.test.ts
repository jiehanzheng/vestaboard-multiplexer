import assert from "node:assert/strict";
import test from "node:test";

import { AppConfigSchema, DEFAULT_APP_CONFIG, PublicConfigSchema } from "../src/config.js";
import { LayoutEntrySchema } from "../src/contracts/config.js";
import { ConfigSaveResponseSchema, DeliveryOutcomeSchema } from "../src/contracts/config.js";
import { BoardElementSchema, PreviewResponseSchema } from "../src/contracts/api.js";

test("board endpoints reject invalid protocols and embedded credentials", () => {
  for (const url of ["not-a-url", "file:///tmp/board", "https://user:secret@board.local/"]) {
    for (const field of ["cloudUrl", "localUrl"] as const) {
      const config = structuredClone(DEFAULT_APP_CONFIG);
      config.transport[field] = url;
      assert.equal(AppConfigSchema.safeParse(config).success, false);
    }
  }
});

test("public configuration schema requires secrets to be omitted", () => {
  const config = structuredClone(DEFAULT_APP_CONFIG);
  config.transport.token = "board-secret";
  config.transport.localApiKey = "local-secret";
  assert.equal(AppConfigSchema.safeParse(config).success, true);
  const publicConfig = structuredClone(config);
  delete publicConfig.transport.token;
  delete publicConfig.transport.localApiKey;
  const response = {
    config: publicConfig,
    legacyEnvironmentVariables: [],
    hasSecrets: { token: true, localApiKey: false }
  };
  assert.equal(PublicConfigSchema.safeParse(response).success, true);
  const parsed = PublicConfigSchema.parse(response);
  assert.equal("token" in parsed.config.transport, false);
  assert.equal("localApiKey" in parsed.config.transport, false);
  assert.equal(PublicConfigSchema.safeParse({ ...response, config }).success, true);
});

test("config save responses add a delivery outcome without changing public config", () => {
  const response = {
    config: structuredClone(DEFAULT_APP_CONFIG),
    legacyEnvironmentVariables: [],
    hasSecrets: { token: false, localApiKey: false },
    delivery: "failed"
  };
  const publicResponse = { ...response };
  delete (publicResponse as { delivery?: string }).delivery;
  assert.equal(PublicConfigSchema.safeParse(publicResponse).success, true);
  assert.equal(PublicConfigSchema.safeParse(response).success, false);
  assert.equal(ConfigSaveResponseSchema.safeParse(response).success, true);
  assert.equal(ConfigSaveResponseSchema.safeParse({ ...response, delivery: "invalid" }).success, false);
  assert.equal(ConfigSaveResponseSchema.safeParse({ ...response, delivery: undefined }).success, false);
  for (const outcome of ["sent", "unchanged", "failed", "paused", "limited", "empty", "stopped"] as const) {
    assert.equal(DeliveryOutcomeSchema.safeParse(outcome).success, true);
  }
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
  assert.equal(BoardElementSchema.safeParse({ id: "water.remaining", label: "Water", height: 1, preview: [[0]] }).success, true);
  assert.equal(BoardElementSchema.safeParse({ id: "water.remaining", label: "Water", height: 1, minWidth: 0, preview: [[0]] }).success, false);
});
