/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_APP_CONFIG, type AppConfig } from "../src/config.js";
import { configPatchForSection, reconcileSectionSave, sectionIsDirty } from "../web/src/draftState.js";
import { createLogDownloadLifecycle, filterLogEntries } from "../web/src/logUtils.js";
import { WaterHeaterStatusSchema, waterElementIssue } from "../src/plugins/waterHeater/status.js";
import { sortLayoutIndexes } from "../web/src/layoutUtils.js";
import { createLatestPreviewQueue, createLatestPreviewScheduler } from "../web/src/previewScheduler.js";
import { homeAssistantRequestKey } from "../web/src/haRequestIdentity.js";

test("row editor order follows board rows while preserving stored ties", () => {
  const layout = [
    { elementId: "water.remaining", startRow: 1 },
    { elementId: "codex.status", startRow: 0 },
    { elementId: "water.temperature-text", startRow: 1 }
  ];
  assert.deepEqual(sortLayoutIndexes(layout), [1, 0, 2]);
});

test("section patches isolate saves and preserve an explicit credential clear", () => {
  const config = structuredClone(DEFAULT_APP_CONFIG);
  config.ha.token = "";
  assert.deepEqual(configPatchForSection("ha", config), { ha: { url: config.ha.url, token: "" } });
  assert.deepEqual(configPatchForSection("codex", config), { codex: config.codex });
});

test("pause section patches include the pause animation draft", () => {
  const config = structuredClone(DEFAULT_APP_CONFIG);
  config.ha.pause = { entityId: "input_boolean.pause", pauseValue: "on", resumeValue: "off" };
  config.pauseOverlay.note[0]![0] = 0;
  const patch = configPatchForSection("pause", config);
  assert.deepEqual(patch, { ha: { pause: config.ha.pause }, pauseOverlay: config.pauseOverlay, transport: { pauseMessageTransition: null } });
  assert.equal("url" in (patch.ha ?? {}), false);
  assert.equal("codex" in patch, false);
});

test("board and pause section patches retain their animation drafts", () => {
  const config = cloneConfigForTest();
  config.transport.localMessageTransition = { strategy: "diagonal", stepIntervalMs: 900, stepSize: 2 };
  config.transport.pauseMessageTransition = { strategy: "random", stepIntervalMs: 500, stepSize: 3 };
  assert.deepEqual(configPatchForSection("board", config).transport?.localMessageTransition, config.transport.localMessageTransition);
  assert.deepEqual(configPatchForSection("pause", config).transport?.pauseMessageTransition, config.transport.pauseMessageTransition);
});

test("board save acknowledgement preserves a newer pause animation draft", () => {
  const saved = structuredClone(DEFAULT_APP_CONFIG);
  saved.transport.pauseMessageTransition = { strategy: "random", stepIntervalMs: 500, stepSize: 3 };
  const submittedDraft = structuredClone(saved);
  submittedDraft.transport.localMessageTransition = { strategy: "column", stepIntervalMs: 900, stepSize: 2 };
  const currentDraft = structuredClone(submittedDraft);
  currentDraft.transport.pauseMessageTransition = { strategy: "diagonal", stepIntervalMs: 700, stepSize: 2 };
  const acknowledgement = { config: structuredClone(saved), legacyEnvironmentVariables: [], hasSecrets: { token: false, localApiKey: false, haToken: false }, delivery: "sent" as const };
  const result = reconcileSectionSave({ section: "board", acknowledgement, submittedDraft, currentDraft });
  assert.equal(result.newerEdits, false);
  assert.deepEqual(result.draftConfig.transport.pauseMessageTransition, currentDraft.transport.pauseMessageTransition);
});

function cloneConfigForTest(): AppConfig {
  return structuredClone(DEFAULT_APP_CONFIG);
}

test("token-only Home Assistant edits are dirty, including an explicit clear", () => {
  const saved = structuredClone(DEFAULT_APP_CONFIG);
  const draft = structuredClone(saved);
  draft.ha.token = "entered-token";
  assert.equal(sectionIsDirty("ha", draft, saved), true);
  draft.ha.token = "";
  assert.equal(sectionIsDirty("ha", draft, saved), true);
});

test("Home Assistant request identity distinguishes retained and cleared tokens", () => {
  const omitted = homeAssistantRequestKey({ url: "http://ha.local" });
  const cleared = homeAssistantRequestKey({ url: "http://ha.local", token: "" });
  assert.notEqual(omitted, cleared);
  assert.notEqual(omitted, homeAssistantRequestKey({ url: "http://ha.local", token: "secret" }));
  assert.equal(omitted, homeAssistantRequestKey({ url: "http://ha.local" }));
});

test("section reconciliation preserves later edits and unrelated drafts", () => {
  const submittedDraft = structuredClone(DEFAULT_APP_CONFIG);
  submittedDraft.codex.enabled = true;
  const currentDraft = structuredClone(submittedDraft);
  currentDraft.codex.autoStartWindowWk = true;
  currentDraft.water.enabled = true;
  const acknowledgement = {
    config: structuredClone(DEFAULT_APP_CONFIG),
    legacyEnvironmentVariables: [],
    hasSecrets: { token: false, localApiKey: false, haToken: false },
    delivery: "sent" as const
  };
  acknowledgement.config.codex.enabled = true;
  const result = reconcileSectionSave({ section: "codex", acknowledgement, submittedDraft, currentDraft });
  assert.equal(result.newerEdits, true);
  assert.equal(result.draftConfig.codex.autoStartWindowWk, true);
  assert.equal(result.draftConfig.water.enabled, true);
  assert.equal(sectionIsDirty("water", result.draftConfig, acknowledgement.config), true);
});

test("a section acknowledgement accepts server normalization when untouched", () => {
  const submittedDraft = structuredClone(DEFAULT_APP_CONFIG);
  submittedDraft.codex.enabled = true;
  const acknowledgement = {
    config: structuredClone(DEFAULT_APP_CONFIG),
    legacyEnvironmentVariables: [],
    hasSecrets: { token: false, localApiKey: false, haToken: false },
    delivery: "sent" as const
  };
  acknowledgement.config.codex.enabled = false;
  const result = reconcileSectionSave({ section: "codex", acknowledgement, submittedDraft, currentDraft: structuredClone(submittedDraft) });
  assert.equal(result.newerEdits, false);
  assert.equal(result.draftConfig.codex.enabled, false);
});

test("HA save keeps a concurrent pause edit", () => {
  const submittedDraft = structuredClone(DEFAULT_APP_CONFIG);
  submittedDraft.ha.url = "http://saved.example";
  const currentDraft = structuredClone(submittedDraft);
  currentDraft.ha.pause = { entityId: "input_boolean.pause", pauseValue: "on", resumeValue: "off" };
  const acknowledgement = { config: structuredClone(submittedDraft), legacyEnvironmentVariables: [], hasSecrets: { token: false, localApiKey: false, haToken: false }, delivery: "sent" as const };
  const result = reconcileSectionSave({ section: "ha", acknowledgement, submittedDraft, currentDraft });
  assert.deepEqual(result.draftConfig.ha.pause, currentDraft.ha.pause);
});

test("pause save keeps concurrent Home Assistant URL and token edits", () => {
  const submittedDraft = structuredClone(DEFAULT_APP_CONFIG);
  submittedDraft.ha.pause = { entityId: "input_boolean.pause", pauseValue: "on", resumeValue: "off" };
  const currentDraft = structuredClone(submittedDraft);
  currentDraft.ha.url = "http://new.example";
  currentDraft.ha.token = "new-token";
  const acknowledgement = { config: structuredClone(submittedDraft), legacyEnvironmentVariables: [], hasSecrets: { token: false, localApiKey: false, haToken: false }, delivery: "sent" as const };
  const result = reconcileSectionSave({ section: "pause", acknowledgement, submittedDraft, currentDraft });
  assert.equal(result.draftConfig.ha.url, "http://new.example");
  assert.equal(result.draftConfig.ha.token, "new-token");
});

test("live preview scheduling uses the latest dirty reading without debounce starvation", () => {
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const rendered: string[] = [];
  const scheduler = createLatestPreviewScheduler({
    delayMs: 180,
    schedule: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    cancel: () => undefined
  });

  scheduler.schedule(() => rendered.push("first"));
  scheduler.schedule(() => rendered.push("latest after live reading"));
  scheduler.schedule(() => rendered.push("latest after another live reading"));
  assert.equal(timers.length, 1);
  assert.equal(timers[0]?.delay, 180);
  timers[0]?.callback();
  assert.deepEqual(rendered, ["latest after another live reading"]);
});

test("slow live preview responses publish and stale draft responses are ignored", async () => {
  const timers: Array<() => void> = [];
  const resolvers: Array<(value: string) => void> = [];
  const committed: string[] = [];
  const queue = createLatestPreviewQueue<string>({
    delayMs: 180,
    schedule: (callback) => {
      timers.push(callback);
      return timers.length;
    },
    cancel: () => undefined
  });
  let payloadRevision = 1;
  const scheduleRequest = (value: string, revision: number): void => queue.schedule({
    task: () => new Promise<string>((resolve) => resolvers.push(resolve)),
    onSuccess: (result) => { if (payloadRevision === revision) committed.push(result); },
    onError: () => undefined,
    onSettled: () => undefined
  });

  scheduleRequest("old live reading", payloadRevision);
  timers.shift()?.();
  scheduleRequest("latest live reading", payloadRevision);
  timers.shift()?.();
  resolvers.shift()?.("live reading preview");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(committed, ["live reading preview"]);

  payloadRevision = 2;
  scheduleRequest("new draft", payloadRevision);
  timers.shift()?.();
  payloadRevision = 3;
  scheduleRequest("latest draft", payloadRevision);
  timers.shift()?.();
  resolvers.shift()?.("stale draft preview");
  await new Promise<void>((resolve) => setImmediate(resolve));
  timers.shift()?.();
  resolvers.shift()?.("latest draft preview");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(committed, ["live reading preview", "latest draft preview"]);
});

test("log filters combine source, severity, and message text", () => {
  const entries = [
    { timestamp: "2026-09-06T00:00:00Z", level: "info" as const, source: "water", message: "reading retained" },
    { timestamp: "2026-09-06T00:00:01Z", level: "error" as const, source: "codex", message: "app server failed" },
    { timestamp: "2026-09-06T00:00:02Z", level: "error" as const, source: "water", message: "entity unavailable" }
  ];
  assert.deepEqual(filterLogEntries(entries, { source: "water", level: "error", text: "entity" }), [entries[2]]);
  assert.deepEqual(filterLogEntries(entries, { source: "all", level: "all", text: "" }), entries);
});

test("log download lifecycle retains the current URL until replacement or cleanup", () => {
  const created: string[] = [];
  const revoked: string[] = [];
  const clicked: string[] = [];
  let nextUrl = 1;
  const lifecycle = createLogDownloadLifecycle({
    createObjectUrl: (content) => {
      created.push(content);
      return `blob:${nextUrl++}`;
    },
    revokeObjectUrl: (url) => revoked.push(url),
    click: (url) => clicked.push(url)
  });
  const entry = { timestamp: "2026-09-06T00:00:00Z", level: "info" as const, source: "application", message: "started" };

  lifecycle.download([entry]);
  assert.deepEqual(clicked, ["blob:1"]);
  assert.deepEqual(revoked, []);
  assert.match(created[0] ?? "", /\[info\] application: started/);
  lifecycle.download([]);
  assert.deepEqual(revoked, ["blob:1"]);
  lifecycle.dispose();
  assert.deepEqual(revoked, ["blob:1", "blob:2"]);
  lifecycle.dispose();
  assert.deepEqual(revoked, ["blob:1", "blob:2"]);
});

test("water diagnostics distinguish disabled, missing, errors, and retained readings", () => {
  const status = WaterHeaterStatusSchema.parse({ enabled: true, inputs: {
    remaining: { configured: true, value: 40, retained: true },
    capacity: { configured: true, value: 80 },
    temperature: { configured: true, error: "Entity unavailable", retained: true },
    target: { configured: true, value: 135 },
    emvPosition: { configured: true, value: 41 },
    heating: { configured: true, value: true }
  } });
  assert.equal(waterElementIssue("water.remaining", status), undefined);
  assert.equal(waterElementIssue("water.temperature-text", status), undefined);
  assert.equal(waterElementIssue("water.temperature-bar", status), undefined);
  assert.match(waterElementIssue("water.emv-position", { ...status, enabled: false }) ?? "", /disabled/);
  assert.match(waterElementIssue("water.remaining", { ...status, inputs: { ...status.inputs, remaining: { configured: false } } }) ?? "", /not configured/);
});

test("delivery holds show their real reason rather than a manual or HA pause", async () => {
  const { pauseReason } = await import("../web/src/utils.js");
  assert.equal(pauseReason({ manualPause: false, haPause: false, pauseReason: "Board size detection pending." }), "Board size detection pending.");
  assert.equal(pauseReason({ manualPause: false, haPause: true }), "Paused by Home Assistant");
  assert.equal(pauseReason({ manualPause: false, haPause: false }), "Delivery blocked");
});
