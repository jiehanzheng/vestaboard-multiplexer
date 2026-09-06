import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createCodexIntegration } from "../src/plugins/codexQuota/integration.js";
import type { CodexConfig } from "../src/plugins/codexQuota/config.js";

function config(overrides: Partial<CodexConfig> = {}): CodexConfig {
  return {
    enabled: true,
    source: "fixture",
    pollIntervalSeconds: 60,
    showPacing: true,
    autoStartWindow5h: false,
    autoStartWindowWk: false,
    demoPauseMinutes: 5,
    ...overrides
  };
}

test("Codex integration collects once and keeps display queries pure", async () => {
  let reads = 0;
  const integration = createCodexIntegration(config(), {
    now: () => new Date("2026-06-19T00:00:00Z"),
    readQuota: async () => {
      reads += 1;
      return { snapshot: { windows: [{ id: "primary", remainingRatio: 0.8, durationMins: 300 }] } };
    }
  });

  await integration.collectInitial();
  const first = integration.status();
  const elementsBefore = integration.elements();
  const second = integration.status();
  const elementsAfter = integration.elements();
  assert.equal(reads, 1);
  assert.deepEqual(second, first);
  assert.deepEqual(elementsAfter.map((element) => element.id), elementsBefore.map((element) => element.id));
  await integration.stop();
});

test("an initially disabled integration starts polling after configure enables it", async () => {
  let reads = 0;
  const integration = createCodexIntegration(config({ enabled: false }), {
    readQuota: async () => {
      reads += 1;
      return { snapshot: { windows: [] } };
    }
  });
  integration.start();
  await integration.configure(config({ enabled: true, pollIntervalSeconds: 60 }));
  await setImmediate();
  assert.equal(reads, 1);
  await integration.stop();
});

test("a Codex source switch clears incompatible readings while outages retain the last good frame", async () => {
  let failed = false;
  const integration = createCodexIntegration(config(), {
    now: () => new Date("2026-06-19T00:00:00Z"),
    readQuota: async () => {
      if (failed) throw new Error("temporary quota failure");
      return { snapshot: { windows: [{ id: "primary", remainingRatio: 0.8, durationMins: 300 }] } };
    }
  });

  await integration.collectInitial();
  const collected = integration.status();
  const goodFrame = integration.elements().find((element) => element.id === "codex.window-1")!.render(15);

  failed = true;
  await integration.collectInitial();
  const outage = integration.status();
  const retainedFrame = integration.elements().find((element) => element.id === "codex.window-1")!.render(15);
  assert.equal(outage.collectedAt, collected.collectedAt);
  assert.notDeepEqual(retainedFrame, goodFrame);

  await integration.configure(config({ source: "app-server" }));
  assert.deepEqual(integration.status(), {});
  const clearedFrame = integration.elements().find((element) => element.id === "codex.window-1")!.render(15);
  assert.notDeepEqual(clearedFrame, retainedFrame);
  await integration.stop();
});
