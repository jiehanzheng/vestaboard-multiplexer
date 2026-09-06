import assert from "node:assert/strict";
import test from "node:test";

import { LegacyCodexQuotaAdapter } from "../src/plugins/codexQuota/legacyAdapter.js";
import type { QuotaPoller } from "../src/plugins/codexQuota/types.js";

test("legacy adapter consumes a demo only for its rendered update", async () => {
  let demoReads = 0;
  const adapter = new LegacyCodexQuotaAdapter({
    priority: "normal",
    errorPriority: "low",
    fixture: true,
    board: async () => "note",
    takeDemoMode: () => demoReads++ === 0 ? { pctDrops: 1 } : undefined,
    readQuota: async () => ({ snapshot: { windows: [
      { id: "primary", remainingRatio: 0.5, durationMins: 300 },
      { id: "weekly", remainingRatio: 0.8, durationMins: 10_080 }
    ] } })
  });

  const first = await adapter.getUpdate();
  const second = await adapter.getUpdate();
  assert.match(first.message.text, /49%/);
  assert.match(second.message.text, /50%/);
  assert.equal(first.priority, "normal");
  assert.equal(second.priority, "normal");
});

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

test("legacy adapter recomputes reset visibility for a successful demo frame", async () => {
  const adapter = new LegacyCodexQuotaAdapter({
    priority: "normal",
    errorPriority: "low",
    board: async () => "note",
    now: () => new Date("2026-06-19T00:00:00Z"),
    timeZone: "UTC",
    takeDemoMode: () => ({ pctDrops: 1 }),
    readQuota: async () => ({ snapshot: { windows: [{
      id: "primary",
      remainingRatio: 1,
      durationMins: 300,
      resetAt: new Date("2026-06-19T05:00:00Z")
    }] } })
  });

  const update = await adapter.getUpdate();
  assert.match(update.message.text, /0500/);
  assert.match(update.message.text, /99%/);
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
