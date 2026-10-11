import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AutomaticUpdateLimits } from "../src/runtime/updateLimits.js";
import { DeliveryController } from "../src/runtime/delivery.js";
import { ConfigStore, DEFAULT_APP_CONFIG } from "../src/config.js";
import { intervalLimit, projectUpdateLimit, UpdateLimitsSchema, type UpdateLimit } from "../src/contracts/updateLimits.js";
import { configPatchForSection, replaceSection, sectionIsDirty } from "../web/src/draftState.js";

const rolling = (id: string, maxUpdates: number, windowMinutes: number): UpdateLimit => ({ id, mode: "rolling", maxUpdates, windowMinutes });
const gradual = (id: string, maxUpdates: number, windowMinutes: number): UpdateLimit => ({ id, mode: "gradual", maxUpdates, windowMinutes });
const logger = { info() {}, warn() {} };

test("rolling slots expire individually at exact trailing-window boundaries, including bypass overflow", () => {
  const limits = new AutomaticUpdateLimits([rolling("hour", 2, 1)], 0);
  limits.reserve(0); limits.reserve(10_000); limits.reserve(20_000);
  assert.equal(limits.status(20_000)[0]!.remaining, 0);
  assert.equal(limits.nextEligibleAt(20_000), 70_000);
  assert.equal(limits.nextEligibleAt(60_000), 70_000, "one expiry cannot repay two occupied slots");
  assert.equal(limits.nextEligibleAt(69_999), 70_000);
  assert.equal(limits.nextEligibleAt(70_000), undefined);
  assert.equal(limits.status(70_000)[0]!.remaining, 1);
  assert.equal(limits.status(80_000)[0]!.remaining, 2);
});

test("gradual credits refill continuously, stop at capacity, and repay settings-save debt", () => {
  const limits = new AutomaticUpdateLimits([gradual("refill", 2, 1)], 0);
  limits.reserve(0); limits.reserve(0); limits.reserve(0);
  assert.equal(limits.status(0)[0]!.credits, -1);
  assert.equal(limits.nextEligibleAt(0), 60_000);
  assert.equal(limits.status(15_000)[0]!.credits, -.5);
  assert.equal(limits.status(30_000)[0]!.remaining, 0);
  assert.equal(limits.nextEligibleAt(59_999), 60_000);
  assert.equal(limits.status(60_000)[0]!.remaining, 1);
  limits.reserve(60_000);
  assert.equal(limits.nextEligibleAt(60_000), 90_000);
  assert.equal(limits.status(1_000_000)[0]!.credits, 2);
});

test("all modes jointly gate admission and only new/changed rules reset usage", () => {
  const rules = [rolling("fast", 1, 1), gradual("slow", 2, 60)];
  const limits = new AutomaticUpdateLimits(rules, 0);
  limits.reserve(0); limits.reserve(0);
  assert.equal(limits.nextEligibleAt(0), 30 * 60_000);
  limits.configure([rules[1]!, rules[0]!, rolling("new", 1, 1)], 0);
  assert.deepEqual(limits.status(0).map((rule) => rule.remaining), [0, 0, 1]);
  limits.configure([gradual("slow", 3, 60), rules[0]!], 0);
  assert.deepEqual(limits.status(0).map((rule) => rule.remaining), [3, 0]);
  const freshProcess = new AutomaticUpdateLimits(rules, 0);
  assert.deepEqual(freshProcess.status(0).map((rule) => rule.remaining), [1, 2]);
});

test("browser projections match live counter release and refill without mutating their source", () => {
  for (const rule of [rolling("a", 2, 1), gradual("b", 2, 1)]) {
    const limits = new AutomaticUpdateLimits([rule], 0);
    limits.reserve(0); limits.reserve(10_000); limits.reserve(10_000);
    const snapshot = limits.status(10_000)[0]!;
    const before = structuredClone(snapshot);
    for (const now of [20_000, 59_999, 60_000, 70_000, 120_000]) {
      assert.deepEqual(projectUpdateLimit(snapshot, now), limits.status(now)[0]);
    }
    assert.deepEqual(snapshot, before);
  }
});

test("failed sends reserve all budgets; no-op and paused checks spend nothing; manual bypass permits debt", async () => {
  let now = 0, fail = true, sends = 0;
  const delivery = new DeliveryController({ limits: [rolling("a", 1, 1), gradual("b", 1, 1)], now: () => new Date(now),
    send: async () => { sends++; if (fail) throw new Error("transport"); }, logger });
  assert.equal((await delivery.attempt()).outcome, "empty");
  delivery.updateFrame({ text: "first" });
  assert.equal((await delivery.attempt()).outcome, "failed");
  assert.deepEqual(delivery.status().limits.map((rule) => rule.remaining), [0, 0]);
  fail = false;
  assert.equal((await delivery.attempt()).outcome, "limited");
  assert.equal((await delivery.attemptManual()).outcome, "sent");
  assert.equal(delivery.status().limits[1]!.credits, -1);
  assert.equal((await delivery.attempt()).outcome, "unchanged");
  assert.equal(delivery.status().pending, false);
  delivery.updateFrame({ text: "latest" }); delivery.pause();
  assert.equal((await delivery.attemptManual()).outcome, "paused");
  delivery.resume(); now = 60_000;
  assert.equal((await delivery.attempt()).outcome, "limited");
  now = 120_000; assert.equal((await delivery.attempt()).outcome, "sent");
  assert.equal(sends, 3);
});

test("in-flight attempts are serialized and the next admission considers only the latest frame", async () => {
  let now = 0;
  const sent: string[] = [];
  let release: () => void = () => {};
  const delivery = new DeliveryController({ limits: [rolling("a", 2, 1)], now: () => new Date(now),
    send: async (frame) => { sent.push(frame.text); if (sent.length === 1) await new Promise<void>((resolve) => { release = resolve; }); }, logger });
  delivery.updateFrame({ text: "first" });
  const first = delivery.attempt();
  const concurrent = delivery.attempt();
  delivery.updateFrame({ text: "intermediate" }); delivery.updateFrame({ text: "latest" });
  release(); await Promise.all([first, concurrent]);
  assert.equal(delivery.status().limits[0]!.used, 1);
  await delivery.attempt();
  assert.deepEqual(sent, ["first", "latest"]);
  delivery.updateFrame({ text: "superseded" }); now = 59_999;
  assert.equal((await delivery.attempt()).outcome, "limited");
  delivery.updateFrame({ text: "final" }); now = 60_000;
  assert.equal((await delivery.attempt()).outcome, "sent");
  assert.deepEqual(sent, ["first", "latest", "final"]);
});

test("startup banner stays outside accounting and its hold still applies to manual saves", async () => {
  let now = 0;
  const delivery = new DeliveryController({ limits: intervalLimit(1), now: () => new Date(now), send: async () => {}, logger });
  await delivery.deliverStartup({ text: "banner" }, 30_000);
  assert.equal(delivery.status().limits[0]!.remaining, 1);
  delivery.updateFrame({ text: "data" });
  assert.equal((await delivery.attemptManual()).outcome, "limited");
  now = 30_000; assert.equal((await delivery.attempt()).outcome, "sent");
  assert.equal(delivery.status().limits[0]!.remaining, 0);
});

test("config migrates legacy saved/env intervals, new rules win, invalid saves are atomic, drafts discard", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-limits-"));
  try {
    const { updateLimits: _rules, ...legacy } = structuredClone(DEFAULT_APP_CONFIG);
    await writeFile(join(directory, "config.json"), JSON.stringify({ version: 1, ...legacy, updateIntervalMinutes: 3 }));
    const store = await ConfigStore.open(directory, {});
    assert.deepEqual(store.get().updateLimits, intervalLimit(3));
    const rules = [rolling("a", 25, 60), gradual("b", 1, 1)];
    await store.save({ updateLimits: rules, updateIntervalMinutes: 99 });
    assert.deepEqual(store.get().updateLimits, rules);
    const before = await readFile(join(directory, "config.json"), "utf8");
    assert.equal(before.includes("updateIntervalMinutes"), false);
    for (const invalid of [[], [rolling("a", 0, 1)], [rolling("a", 1, Infinity)], [rolling("a", 1, 1), rolling("a", 2, 2)]]) {
      await assert.rejects(store.save({ updateLimits: invalid }));
      assert.equal(await readFile(join(directory, "config.json"), "utf8"), before);
    }
    const saved = store.get(), draft = { ...saved, updateLimits: [gradual("a", 7, 1)] };
    assert.equal(sectionIsDirty("board", draft, saved), true);
    assert.deepEqual(configPatchForSection("board", draft).updateLimits, draft.updateLimits);
    assert.deepEqual(replaceSection(draft, saved, "board").updateLimits, rules);
    assert.deepEqual((await ConfigStore.open(directory, {})).get().updateLimits, rules);
    const defaults = await ConfigStore.open(join(directory, "fresh"), {});
    assert.deepEqual(defaults.get().updateLimits, intervalLimit(5));
    const env = await ConfigStore.open(join(directory, "env"), { ORCHESTRATOR_INTERVAL_MINUTES: "3" });
    assert.deepEqual(env.get().updateLimits, intervalLimit(3));
    assert.equal(UpdateLimitsSchema.parse([{ id: "new", maxUpdates: 1, windowMinutes: 1 }])[0]!.mode, "rolling");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("scheduler admits the latest frame at its deadline and handles periods beyond timer maximum", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  const sent: string[] = [];
  const delivery = new DeliveryController({ limits: [rolling("long", 1, 50_000)], now: () => new Date(now),
    send: async (frame) => { sent.push(frame.text); }, logger });
  delivery.updateFrame({ text: "first" });
  const scheduler = delivery.startScheduler();
  await delivery.attempt();
  delivery.updateFrame({ text: "intermediate" });
  await delivery.attempt();
  await Promise.resolve();
  now = 2_147_483_647;
  context.mock.timers.tick(now);
  await delivery.attempt();
  await Promise.resolve();
  assert.deepEqual(sent, ["first"], "a timer chunk must not admit a long-window write early");
  delivery.updateFrame({ text: "latest" });
  await delivery.attempt();
  await Promise.resolve();
  now = 3_000_000_000;
  context.mock.timers.tick(now - 2_147_483_647);
  await delivery.attempt();
  assert.deepEqual(sent, ["first", "latest"]);
  await delivery.stop(); await scheduler;
});
