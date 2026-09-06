import assert from "node:assert/strict";
import test from "node:test";

import { LegacyCodexQuotaAdapter } from "../src/plugins/codexQuota/legacyAdapter.js";
import type { QuotaPoller } from "../src/plugins/codexQuota/types.js";

test("legacy adapter renders the final cached ingredients after a collection failure", async () => {
  let fail = false;
  const readQuota: QuotaPoller = async () => {
    if (fail) throw new Error("temporary unavailable");
    return { snapshot: { windows: [{ id: "primary", remainingRatio: 0.5, durationMins: 300 }] } };
  };
  const adapter = new LegacyCodexQuotaAdapter({
    priority: "normal",
    errorPriority: "low",
    board: async () => "note",
    readQuota
  });

  await adapter.getUpdate();
  fail = true;
  const fallback = await adapter.getUpdate();
  assert.match(fallback.message.text, /FETCH FAIL/);
  assert.match(fallback.message.text, /49%|50%/);
  assert.equal(fallback.priority, "high");
});

test("legacy adapter keeps configured error priority when no cached snapshot exists", async () => {
  const adapter = new LegacyCodexQuotaAdapter({
    priority: "normal",
    errorPriority: "low",
    board: async () => "note",
    readQuota: async () => { throw new Error("initial unavailable"); }
  });

  const update = await adapter.getUpdate();
  assert.equal(update.priority, "low");
  assert.match(update.message.text, /CODEX QUOTA ERR/);
});

test("legacy adapter composes the flagship default layout from one captured state", async () => {
  const adapter = new LegacyCodexQuotaAdapter({
    priority: "normal",
    errorPriority: "low",
    board: async () => "flagship",
    statusMessage: () => "check",
    readQuota: async () => ({ snapshot: { windows: [
      { id: "primary", remainingRatio: 0.5, durationMins: 300 },
      { id: "weekly", remainingRatio: 0.8, durationMins: 10_080 }
    ] } })
  });

  const update = await adapter.getUpdate();
  assert.equal(update.message.characters?.length, 6);
  assert.ok(update.message.characters?.every((row) => row.length === 22));
  assert.match(update.message.text, /CHECK/);
});
