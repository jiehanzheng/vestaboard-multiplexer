import { BarRowConfigSchema } from "../src/plugins/barRows/config.js";
import { encode } from "../src/vestaboardCharacters.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, type PublicConfig } from "../src/config.js";
import { createApplication } from "../src/application.js";
import { HomeAssistantClient, type HAEntity, type HomeAssistantClientOptions, type HomeAssistantSocket } from "../src/homeAssistant.js";
import { createCodexIntegration } from "../src/plugins/codexQuota/integration.js";
import type { VestaboardMessage } from "../src/vestaboard.js";
import { PauseStore } from "../src/pause.js";

class FakeHomeAssistantClient {
  private entities: HAEntity[] = [];
  private started = false;
  private connected = false;
  stopped = false;

  constructor(private readonly options: HomeAssistantClientOptions) {}

  start(): void { this.started = true; this.connected = true; }
  stop(): void { this.stopped = true; }
  waitUntilReady(): Promise<void> { return Promise.resolve(); }
  readEntities(ids: readonly string[]): readonly HAEntity[] { return this.entities.filter((entity) => ids.includes(entity.entity_id)); }
  states(): HAEntity[] { return this.entities.map((entity) => ({ ...entity, attributes: { ...entity.attributes } })); }
  status(): { connected: boolean } { return { connected: this.started && !this.stopped && this.connected }; }
  setConnected(value: boolean): void { this.connected = value; }
  async emit(entities: HAEntity[]): Promise<void> {
    this.entities = entities;
    const callback = (this.options.changed as unknown as ((change: {kind: "initial"}) => void | Promise<void>) | undefined)?.({kind: "initial"});
    if (callback instanceof Promise) await callback;
  }
}

const asHomeAssistantClient = (client: FakeHomeAssistantClient): HomeAssistantClient => client as unknown as HomeAssistantClient;

test("HA event storms cache all entities but compose only relevant changes once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-scoped-events-"));
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture" });
  const binding = (id: string, entityId: string) => ({ id, name: id, enabled: true, entityId, attribute: "characters",
    width: 3, height: 1, unavailableDisplay: "blank" as const, staleAfterMinutes: 15 });
  const music = (characters: number[], temperature = 120): HAEntity => ({ entity_id: "sensor.music", state: "ready", attributes: { characters, temperature } });
  const other: HAEntity = { entity_id: "sensor.other", state: "ready", attributes: { characters: [1, 2, 3] } };
  const initial = [music([68, 10, 26]), other,
    ...Array.from({ length: 3_000 }, (_, i) => ({ entity_id: `sensor.noise_${i}`, state: "0", attributes: {} }))];
  await store.save({ board: "note", updateIntervalMinutes: 3, codex: { enabled: false }, ha: { url: "http://ha.test" },
    water: { enabled: true, remaining: { constant: 40 }, capacity: { constant: 80 },
      temperature: { entityId: "sensor.music", attribute: "temperature" }, target: { constant: 140 } },
    haBlocks: [binding("music", "sensor.music"), binding("other", "sensor.other")],
    layout: [{ elementId: "water.temperature-text", startRow: 0, width: 8 },
      { elementId: "ha-block.other", startRow: 1, startColumn: 12, width: 3 },
      { elementId: "ha-block.music", startRow: 2, startColumn: 12, width: 3 }] });
  let client!: HomeAssistantClient;
  let socket!: HomeAssistantSocket;
  let compositions = 0; let broadcasts = 0; let exports = 0; let reads = 0; let references = 0; let time = 0;
  const sent: VestaboardMessage[] = [];
  const receive = (message: unknown) => socket.onmessage?.({ data: JSON.stringify(message) });
  const app = await createApplication(store, directory, true, {
    now: () => new Date(time), setInterval: (() => 1) as unknown as typeof setInterval, clearInterval() {},
    createVestaboardClient: () => ({ send: async (frame) => { sent.push(frame); }, detectBoard: async () => "note" as const }),
    createCodexIntegration: (config, dependencies) => {
      const integration = createCodexIntegration(config, dependencies); const elements = integration.elements.bind(integration);
      integration.elements = (draft) => { compositions++; return elements(draft); }; return integration;
    },
    createHomeAssistantClient: (options) => {
      client = new HomeAssistantClient({ ...options, socketFactory: () => {
        socket = { onopen: null, onclose: null, onerror: null, onmessage: null, close() {}, send(raw) {
          const message = JSON.parse(raw) as { type: string; id: number };
          if (message.type === "auth") queueMicrotask(() => receive({ type: "auth_ok" }));
          if (message.type === "subscribe_events") queueMicrotask(() => receive({ type: "result", id: message.id, success: true, result: null }));
          if (message.type === "get_states") queueMicrotask(() => receive({ type: "result", id: message.id, success: true, result: initial }));
        } };
        queueMicrotask(() => receive({ type: "auth_required" })); return socket;
      } });
      const states = client.states.bind(client); const selected = client.readEntities.bind(client);
      client.states = () => { exports++; return states(); };
      client.readEntities = (ids) => { reads++; const values = selected(ids); references += values.length; return values; };
      return client;
    }
  });
  const event = (entityId: string, new_state: HAEntity | null) => receive({ type: "event", event: { event_type: "state_changed", data: { entity_id: entityId, new_state } } });
  try {
    app.onChange(() => { broadcasts++; app.actions.status(); });
    await app.start(); await client.waitUntilReady(); await Promise.resolve();
    assert.deepEqual(app.actions.status().desired!.characters![2]!.slice(12), [68, 10, 26]);
    compositions = 0; broadcasts = 0; reads = 0; references = 0;
    for (let i = 0; i < 500; i++) event(`sensor.noise_${i}`, { entity_id: `sensor.noise_${i}`, state: "1", attributes: {} });
    await Promise.resolve();
    assert.equal(compositions, 0); assert.equal(broadcasts, 0); assert.equal(reads, 0); assert.equal(exports, 0);
    const sentBeforePause = sent.length;
    event("sensor.music", music([69, 10, 26], 121)); await Promise.resolve();
    assert.equal(compositions, 1, "water and two block instances share one composition");
    assert.equal(broadcasts, 1);
    assert.equal(reads, 3, "water callback, block callback and coherent composition only");
    assert.equal(references, 5, "one water source plus two block and two composition references");
    assert.deepEqual(app.actions.status().desired!.characters![2]!.slice(12), [69, 10, 26]);
    assert.equal(sent.length, sentBeforePause, "physical delivery remains interval-limited");
    const inspection = await app.actions.homeAssistant!("entities", {}) as { entities: HAEntity[] };
    assert.equal(inspection.entities.find((e) => e.entity_id === "sensor.noise_499")!.state, "1");
    assert.equal(exports, 1);
    compositions = 0; broadcasts = 0;
    event("sensor.music", music([69, 10, 26], 121)); await Promise.resolve();
    assert.equal(compositions, 0); assert.equal(broadcasts, 0, "unchanged visible inputs do not redraw");
    await app.actions.save({ haBlocks: [binding("music", "sensor.new"), binding("other", "sensor.other")] });
    compositions = 0; broadcasts = 0;
    event("sensor.music", music([68, 10, 26], 121)); await Promise.resolve();
    assert.equal(compositions, 0, "old block binding is removed; unchanged water data also stays quiet");
    event("sensor.new", { entity_id: "sensor.new", state: "ready", attributes: { characters: [68, 25, 13] } }); await Promise.resolve();
    assert.deepEqual(app.actions.status().desired!.characters![2]!.slice(12), [68, 25, 13]);
    assert.deepEqual(app.actions.status().desired!.characters![1]!.slice(12), [1, 2, 3]);
    event("sensor.new", null); await Promise.resolve();
    assert.deepEqual(app.actions.status().desired!.characters![2]!.slice(12), [0, 0, 0]);
    socket.onerror?.(); await Promise.resolve();
    assert.equal(app.actions.status().homeAssistant!.connected, false);
    assert.deepEqual(app.actions.status().desired!.characters![1]!.slice(12), [0, 0, 0]);
    client.stop(); client.start(); await client.waitUntilReady(); await Promise.resolve();
    assert.equal(app.actions.status().homeAssistant!.connected, true);
    assert.deepEqual(app.actions.status().desired!.characters![1]!.slice(12), [1, 2, 3], "recovery refreshes all bindings");
    await app.actions.save({ haBlocks: [binding("music", "sensor.new")],
      layout: store.get().layout!.filter((entry) => entry.elementId !== "ha-block.other") });
    compositions = 0; broadcasts = 0;
    event("sensor.other", { ...other, attributes: { characters: [4, 5, 6] } }); await Promise.resolve();
    assert.equal(compositions, 0); assert.equal(broadcasts, 0, "removed instances leave no subscription");
    assert.equal(store.get().updateLimits[0]!.windowMinutes, 3);
    time += 180_000;
  } finally { await app.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("auto-detected board changes reject layouts before persisting the new target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-target-layout-"));
  const store = await ConfigStore.open(directory, {});
  await store.save({ ...store.get(), board: "flagship", codex: { ...store.get().codex, enabled: false }, layout: [{ elementId: "codex.status", startRow: 5 }] });
  const app = await createApplication(store, directory, true, {
    createVestaboardClient: () => ({ send: async () => {}, detectBoard: async () => "note" as const })
  });
  try {
    await app.start();
    const before = store.get();
    await assert.rejects(app.actions.save({ board: "auto" }), /out of bounds/);
    assert.deepEqual(store.get(), before);
    assert.equal(app.actions.status().board, "flagship");
    assert.equal(app.actions.status().configError, undefined);
  } finally { await app.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("auto board detection retries before delivering a frame with assumed dimensions", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-board-retry-"));
  const sent: VestaboardMessage[] = [];
  let detections = 0;
  let tick!: () => void;
  let resolveComposition!: () => void;
  const compositionSent = new Promise<void>((resolve) => { resolveComposition = resolve; });
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_TOKEN: "board-token" });
  const app = await createApplication(store, directory, true, {
    setInterval: ((callback: () => void) => {
      tick = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: () => {},
    createVestaboardClient: () => ({
      detectBoard: async () => {
        detections += 1;
        return detections === 1 ? undefined : "flagship";
      },
      send: async (frame: VestaboardMessage) => {
        sent.push(frame);
        if (frame.characters) resolveComposition();
      }
    })
  });
  const confirmed = new Promise<void>((resolve) => {
    app.onChange(() => {
      if (app.actions.status().board === "flagship") resolve();
    });
  });
  try {
    await app.start();
    tick();
    await Promise.all([confirmed, compositionSent]);
    assert.equal(detections, 2);
    const composed = sent.filter((frame) => frame.characters);
    assert.ok(composed.length > 0);
    assert.ok(composed.every((frame) => frame.characters?.length === 6 && frame.characters.every((row) => row.length === 22)));
  } finally { await app.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("same-size auto detection confirmation resumes the paused composition", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-board-confirmation-"));
  const sent: VestaboardMessage[] = [];
  let detections = 0;
  let tick!: () => void;
  let resolveComposition!: () => void;
  const compositionSent = new Promise<void>((resolve) => { resolveComposition = resolve; });
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_TOKEN: "board-token" });
  const app = await createApplication(store, directory, true, {
    setInterval: ((callback: () => void) => {
      tick = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: () => {},
    createVestaboardClient: () => ({
      detectBoard: async () => {
        detections += 1;
        return detections === 1 ? undefined : "note";
      },
      send: async (frame: VestaboardMessage) => {
        sent.push(frame);
        if (frame.characters) resolveComposition();
      }
    })
  });
  try {
    await app.start();
    tick();
    await compositionSent;
    assert.equal(detections, 2);
    const composed = sent.filter((frame) => frame.characters);
    assert.ok(composed.length > 0);
    assert.ok(composed.every((frame) => frame.characters?.length === 3 && frame.characters.every((row) => row.length === 15)));
    assert.equal(app.actions.status().paused, false);
  } finally { await app.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("board detection retry waits behind a target save and cannot replace its resolver", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-board-save-race-"));
  let detections = 0;
  let tick!: () => void;
  let resolveCandidate!: (board: "note" | "flagship") => void;
  let candidateStarted!: () => void;
  const candidateReady = new Promise<void>((resolve) => { candidateStarted = resolve; });
  const candidateBoard = new Promise<"note" | "flagship">((resolve) => { resolveCandidate = resolve; });
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_BOARD: "auto", VESTABOARD_TOKEN: "board-token" });
  const app = await createApplication(store, directory, true, {
    setInterval: ((callback: () => void) => {
      tick = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: () => {},
    createVestaboardClient: () => ({
      detectBoard: async () => {
        detections += 1;
        if (detections === 1) return undefined;
        if (detections === 2) {
          candidateStarted();
          return candidateBoard;
        }
        return "note";
      },
      send: async () => {}
    })
  });
  try {
    await app.start();
    const next = store.get();
    next.transport.token = "new-board-token";
    const saving = app.actions.save(next);
    await candidateReady;
    tick();
    resolveCandidate("flagship");
    await saving;
    assert.equal(detections, 2, "the queued retry must not call the old resolver after the save replaces it");
    assert.equal(app.actions.status().board, "flagship");
    assert.equal(app.actions.status().paused, false, "a confirmed saved target must not inherit the old retry pause");
  } finally { await app.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("server and one-shot share frames, and status/preview cannot collect or deliver", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-parity-"));
  const now = () => new Date("2026-09-06T12:00:00Z");
  let reads = 0;
  let collected!: () => void;
  const firstRead = new Promise<void>((resolve) => { collected = resolve; });
  const sent: VestaboardMessage[] = [];
  const dependencies = {
    now,
    createVestaboardClient: () => ({ send: async (frame: VestaboardMessage) => { sent.push(frame); } }),
    createCodexIntegration: (config: Parameters<typeof createCodexIntegration>[0], options: Parameters<typeof createCodexIntegration>[1]) => createCodexIntegration(config, {
      ...options,
      readQuota: async () => {
        reads++;
        return { snapshot: { windows: [{ id: "primary", remainingRatio: 0.5, durationMins: 300, resetAt: new Date("2026-09-06T15:00:00Z") }] } };
      }
    })
  };
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_BOARD: "note" });
  const server = await createApplication(store, directory, true, dependencies);
  server.onChange(() => { if (server.actions.status().codex.collectedAt) collected(); });
  try {
    await server.start();
    await firstRead;
    assert.equal(server.actions.status().dryRun, true);
    assert.ok(server.actions.logs?.().entries.some((entry) => entry.source === "application" && entry.message.includes("Application started")));
    const desired = server.actions.status().desired;
    const before = { reads, writes: sent.length };
    const layout = server.actions.elements().defaultLayout!;
    for (let i = 0; i < 3; i++) {
      server.actions.status(); server.actions.elements();
      const { selection, barRows: _barRows, ...previewFrame } = server.actions.preview({ layout, board: "note" });
      assert.deepEqual(previewFrame, desired);
      assert.ok(selection?.every((entry) => entry.reason === "shown"));
    }
    assert.deepEqual({ reads, writes: sent.length }, before);
    await server.stop();
    const once = await createApplication(store, directory, true, dependencies);
    try {
      const previousWrites = sent.length;
      await once.runOnce();
      assert.equal(sent.length, previousWrites + 1, "one-shot must not send a startup banner");
      assert.deepEqual(sent.at(-1), desired);
    } finally { await once.stop(); }
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("successful settings saves make one immediate delivery without leaving a bypass pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-manual-save-"));
  let nowMs = 0;
  let failSends = false;
  const sent: VestaboardMessage[] = [];
  const store = await ConfigStore.open(directory, {
    CODEX_QUOTA_SOURCE: "fixture",
    VESTABOARD_BOARD: "note",
    ORCHESTRATOR_INTERVAL_MINUTES: "5"
  });
  const app = await createApplication(store, directory, true, {
    now: () => new Date(nowMs),
    createVestaboardClient: () => ({
      send: async (frame: VestaboardMessage) => {
        sent.push(frame);
        if (failSends) throw new Error("board unavailable");
      }
    })
  });
  try {
    await app.runOnce();
    const initialWrites = sent.length;
    const initial = store.get();
    nowMs = 1_000;

    const changedResponse = await app.actions.save({ ...initial, layout: [] });
    assert.equal(sent.length, initialWrites + 1, "changed saved settings should send immediately");
    assert.equal(changedResponse.delivery, "sent");

    const afterChangedSave = store.get();
    const unchangedResponse = await app.actions.save({ ...afterChangedSave });
    assert.equal(sent.length, initialWrites + 1, "an unchanged saved frame should not write");
    assert.equal(unchangedResponse.delivery, "unchanged");

    const beforeFailedSave = sent.length;
    await assert.rejects(app.actions.save({ ...afterChangedSave, layout: [{ elementId: "codex.status", startRow: 5 }] }), /out of bounds/);
    assert.equal(sent.length, beforeFailedSave, "an invalid save should not trigger a delivery");

    await app.actions.pause({ paused: true });
    await app.actions.save({ ...afterChangedSave, layout: [{ elementId: "codex.status", startRow: 0 }] });
    assert.equal(sent.length, beforeFailedSave, "a paused save should not write");
    const changedOverlay = structuredClone(afterChangedSave.pauseOverlay);
    changedOverlay.note[0]![0] = 0;
    const overlayResponse = await app.actions.save({ ...afterChangedSave, pauseOverlay: changedOverlay });
    assert.equal(overlayResponse.delivery, "limited", "a paused overlay save uses the normal limiter");
    assert.equal(sent.length, beforeFailedSave, "a paused overlay save must not bypass the normal limiter");
    const currentAfterOverlaySave = store.get();
    assert.equal((await app.actions.save({ ...currentAfterOverlaySave, layout: [] })).delivery, "paused");
    assert.equal(sent.length, beforeFailedSave, "a second paused save should not write");
    await app.actions.pause({ paused: false });
    assert.equal(sent.length, beforeFailedSave, "resuming should not release a saved bypass later");

    failSends = true;
    const beforeBoardFailure = sent.length;
    const failedBoardSave = { ...currentAfterOverlaySave, layout: [{ elementId: "codex.status", startRow: 1 }] };
    const failedBoardResponse = await app.actions.save(failedBoardSave);
    assert.equal(sent.length, beforeBoardFailure + 1, "a board failure still consumes one manual attempt");
    assert.equal(failedBoardResponse.delivery, "failed");
    assert.deepEqual((app.actions.config() as PublicConfig).config.layout, failedBoardSave.layout);
    assert.equal(app.actions.status().configError, undefined, "a board failure must not report a settings save failure");
    assert.match(app.actions.status().deliveryError ?? "", /Board update failed/);
  } finally {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("remembered pause waits for the first collection before exposing a writable frame", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-startup-pause-"));
  const pauseStore = await PauseStore.open(directory);
  await pauseStore.setManual(true);
  let releaseRead!: () => void;
  const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
  let collected!: () => void;
  const firstCollection = new Promise<void>((resolve) => { collected = resolve; });
  let initialHold!: () => void;
  const initialHoldReady = new Promise<void>((resolve) => { initialHold = resolve; });
  const sent: VestaboardMessage[] = [];
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_TOKEN: "board-token" });
  const app = await createApplication(store, directory, true, {
    createCodexIntegration: (config, options) => createCodexIntegration(config, {
      ...options,
      readQuota: async () => {
        await readReleased;
        return { snapshot: { windows: [{ id: "primary", remainingRatio: 0.5, durationMins: 300, resetAt: new Date("2026-09-06T15:00:00Z") }] } };
      }
    }),
    createVestaboardClient: () => ({ send: async (frame: VestaboardMessage) => { sent.push(frame); } })
  });
  app.onChange(() => {
    if ((app.actions.status().pauseReason ?? "").match(/initial collection/i)) initialHold();
    if (app.actions.status().codex.collectedAt) collected();
  });
  try {
    const starting = app.start();
    await initialHoldReady;
    assert.equal(sent.length, 0, "startup pause must not write a blank overlay before collection");
    assert.match(app.actions.status().pauseReason ?? "", /initial collection/i);
    releaseRead();
    await Promise.all([starting, firstCollection]);
    assert.equal(sent.length, 1, "startup pause sends the collected overlay only after collection settles");
    assert.ok(app.actions.status().pauseBackground?.characters?.some((row) => row.some((cell) => cell !== 0)));
  } finally {
    releaseRead();
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pause freezes the last clean frame while collection continues and resumes with the latest frame", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-frozen-frame-"));
  let nowMs = 0;
  let read = 0;
  const sent: VestaboardMessage[] = [];
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_BOARD: "note" });
  const app = await createApplication(store, directory, true, {
    now: () => new Date(nowMs),
    createCodexIntegration: (config, options) => createCodexIntegration(config, {
      ...options,
      readQuota: async () => ({ snapshot: { windows: [{ id: "primary", remainingRatio: read++ === 0 ? 0.8 : 0.1, durationMins: 300, resetAt: new Date("2026-09-06T15:00:00Z") }] } })
    }),
    createVestaboardClient: () => ({ send: async (frame: VestaboardMessage) => { sent.push(frame); } })
  });
  try {
    await app.runOnce();
    const first = structuredClone(sent.at(-1));
    nowMs = 1_000;
    await app.actions.pause({ paused: true });
    await app.runOnce();
    assert.equal(sent.length, 1, "a fresh collection must not drift the physical board while paused");
    assert.deepEqual(app.actions.status().pauseBackground, first, "pause background stays the clean frame before the overlay");
    nowMs = 5 * 60_000;
    await app.actions.pause({ paused: false });
    assert.equal(sent.length, 2, "resume sends the latest collected frame when the normal interval allows it");
    assert.notDeepEqual(sent.at(-1), first, "resume does not resend the stale frozen frame");
  } finally {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pause and resume writes use one optional local animation override", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-animation-transition-"));
  let nowMs = 0;
  const transitions: Array<unknown> = [];
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_BOARD: "note" });
  const normal = { strategy: "row" as const, stepIntervalMs: 2_000, stepSize: 1 };
  const pause = { strategy: "diagonal" as const, stepIntervalMs: 500, stepSize: 2 };
  await store.save({ transport: { localApiKey: "local-key", localMessageTransition: normal, pauseMessageTransition: pause } });
  const app = await createApplication(store, directory, true, {
    now: () => new Date(nowMs),
    createVestaboardClient: (options) => {
      transitions.push(options.localMessageTransition);
      return { send: async () => {} };
    }
  });
  try {
    await app.runOnce();
    nowMs = 5 * 60_000;
    await app.actions.pause({ paused: true });
    nowMs = 10 * 60_000;
    await app.actions.pause({ paused: false });
    assert.deepEqual(transitions.slice(-3), [normal, pause, pause]);
  } finally {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Home Assistant pause binding saves use normal cadence when they pause or resume delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-ha-save-cadence-"));
  let nowMs = 0;
  const sent: VestaboardMessage[] = [];
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_BOARD: "note" });
  const app = await createApplication(store, directory, true, {
    now: () => new Date(nowMs),
    createHomeAssistantClient: (options) => asHomeAssistantClient(new FakeHomeAssistantClient(options)),
    createVestaboardClient: () => ({ send: async (frame: VestaboardMessage) => { sent.push(frame); } })
  });
  try {
    await app.runOnce();
    const initialWrites = sent.length;
    nowMs = 1_000;
    const withPause = { ...store.get(), ha: { url: "http://ha.local", pause: { entityId: "input_boolean.pause", pauseValue: "on", resumeValue: "off" } } };
    assert.equal((await app.actions.save(withPause)).delivery, "limited", "binding save must use the normal delivery limiter");
    assert.equal(app.actions.status().paused, true, "a newly configured HA binding is fail-closed until its state is observed");
    assert.equal(sent.length, initialWrites, "binding save must not bypass delivery while it fail-closes paused");
    const cleared = { ...store.get(), ha: { url: "", pause: null } };
    assert.equal((await app.actions.save(cleared)).delivery, "unchanged", "the resumed frame already matches the last output");
    assert.equal(app.actions.status().paused, false, "removing the HA binding resumes semantic delivery");
    assert.equal(sent.length, initialWrites, "binding removal must respect the normal delivery deadline");
  } finally {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid environment configuration is visible and blocks delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-env-error-"));
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", ORCHESTRATOR_INTERVAL_MINUTES: "bad" });
  let writes = 0;
  const app = await createApplication(store, directory, true, { createVestaboardClient: () => ({ send: async () => { writes++; } }) });
  try {
    await app.runOnce();
    assert.equal(writes, 0);
    assert.match(app.actions.status().configError ?? "", /ORCHESTRATOR_INTERVAL_MINUTES/);
    assert.doesNotMatch(app.actions.status().configError ?? "", /bad/);
    await assert.rejects(stat(join(directory, "config.json")));
  } finally { await app.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("web application can configure an unconnected board and preview without sending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-app-"));
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_BOARD: "note" });
  const app = await createApplication(store, directory, false);
  try {
    await app.start();
    const initial = app.actions.status() as { configError?: string; lastSent?: unknown };
    assert.equal(app.actions.status().dryRun, false);
    assert.match(initial.configError!, /board connection/);
    assert.equal(initial.lastSent, undefined);
    const before = store.get();
    assert.throws(() => app.actions.preview({ layout: [{ elementId: "codex.window-1-large", startRow: 2 }], board: "note" }));
    assert.deepEqual(store.get(), before);
    await app.actions.save({ ...before, layout: [] });
    assert.deepEqual((app.actions.config() as PublicConfig).config.layout, []);
    await app.actions.pause({ paused: true });
    assert.equal((app.actions.status() as { paused: boolean }).paused, true);
    await app.actions.pause({ paused: false });
    assert.equal((app.actions.status() as { lastSent?: unknown }).lastSent, undefined);
  } finally {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("application exposes constants-only water elements without a Home Assistant connection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-water-"));
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_BOARD: "note" });
  const app = await createApplication(store, directory, true);
  try {
    await app.start();
    const before = store.get();
    await app.actions.save({
      ...before,
      water: {
        ...before.water,
        enabled: true,
        remaining: { constant: 40 },
        capacity: { constant: 80 },
        temperature: { constant: 120 },
        target: { constant: 140 }
      }
    });
    const savedWater = store.get().water;

    const elementIds = (app.actions.elements() as { elements: Array<{ id: string }> }).elements.map((element) => element.id);
    assert.deepEqual(elementIds.filter((id) => id.startsWith("water.")), [
      "water.remaining",
      "water.temperature-text",
      "water.emv-position"
    ]);
    const elementMetadata = (app.actions.elements() as { elements: Array<{ id: string; minWidth?: number }> }).elements;
    assert.equal(elementMetadata.find((element) => element.id === "codex.window-1")?.minWidth, 6);
    assert.equal(elementMetadata.find((element) => element.id === "water.remaining")?.minWidth, 6);
    assert.equal(elementMetadata.find((element) => element.id === "water.temperature-text")?.minWidth, 8);
    assert.equal(elementMetadata.find((element) => element.id === "water.emv-position")?.minWidth, 6);
    const waterStatus = (app.actions.status() as { water: { enabled: boolean; inputs: Record<string, { value?: number }> } }).water;
    assert.equal(waterStatus.enabled, true);
    assert.equal(waterStatus.inputs.temperature?.value, 120);

    const draftWater = {
      ...before.water,
      enabled: true,
      remaining: { constant: 40 },
      capacity: { constant: 80 },
      temperature: { constant: 125 },
      target: { constant: 135 }
    };
    const preview = (app.actions.preview({
      layout: [
        { elementId: "water.remaining", startRow: 0 },
        { elementId: "water.temperature-text", startRow: 1 }
      ],
      board: "note",
      water: draftWater
    }) as { characters: number[][] }).characters;
    assert.ok(preview.some((row) => row.some((value) => value !== 0)));
    assert.deepEqual(store.get().water, savedWater);
  } finally {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("same Home Assistant connection applies a newly selected cached pause entity", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-ha-binding-"));
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_BOARD: "note" });
  const base = store.get();
  await store.save({
    ...base,
    ha: { url: "http://ha.local", pause: { entityId: "input_boolean.old", pauseValue: "on", resumeValue: "off" } }
  });
  const clients: FakeHomeAssistantClient[] = [];
  const app = await createApplication(store, directory, true, {
    createHomeAssistantClient: (options) => {
      const client = new FakeHomeAssistantClient(options);
      clients.push(client);
      return asHomeAssistantClient(client);
    }
  });
  try {
    await app.start();
    assert.equal(clients.length, 1);
    const persistent = clients[0];
    assert.ok(persistent);
    await persistent.emit([
      { entity_id: "input_boolean.old", state: "off", attributes: {} },
      { entity_id: "input_boolean.new", state: "off", attributes: {} }
    ]);
    persistent.setConnected(false);
    await app.actions.save({
      ...store.get(),
      ha: { url: "http://ha.local", pause: { entityId: "input_boolean.new", pauseValue: "on", resumeValue: "off" } }
    });
    assert.equal(clients.length, 1);
    assert.equal((app.actions.status() as { paused: boolean }).paused, true);
    persistent.setConnected(true);
    const resumed = new Promise<void>((resolve) => app.onChange(() => { if (!app.actions.status().paused) resolve(); }));
    await persistent.emit([{ entity_id: "input_boolean.new", state: "off", attributes: {} }]);
    await resumed;
    assert.equal((app.actions.status() as { paused: boolean }).paused, false);
  } finally {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("Home Assistant pause stays fail-closed and all clients stop with the application", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-ha-cleanup-"));
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_BOARD: "note" });
  const base = store.get();
  await store.save({
    ...base,
    ha: { url: "http://ha.local", pause: { entityId: "input_boolean.pause", pauseValue: "on", resumeValue: "off" } }
  });
  const clients: FakeHomeAssistantClient[] = [];
  const app = await createApplication(store, directory, true, {
    createHomeAssistantClient: (options) => {
      const client = new FakeHomeAssistantClient(options);
      clients.push(client);
      return asHomeAssistantClient(client);
    }
  });
  try {
    await app.start();
    const persistent = clients[0];
    assert.ok(persistent);
    await persistent.emit([{ entity_id: "input_boolean.pause", state: "on", attributes: {} }]);
    await app.actions.pause({ paused: false });
    assert.equal((app.actions.status() as { paused: boolean }).paused, true);
    assert.ok(app.actions.homeAssistant);
    await app.actions.homeAssistant("test", { url: "http://temporary.local", token: "secret" });
    assert.equal(clients.length, 2);
    const temporary = clients[1];
    assert.ok(temporary);
    assert.equal(temporary.stopped, true);
  } finally {
    await app.stop();
    assert.equal(clients[0]?.stopped, true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("HA block shares the live connection and validates size plus placement atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-ha-block-"));
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_BOARD: "note" });
  const initialLayout = [
    { elementId: "water.remaining", startRow: 1 },
    { elementId: "codex.window-1", startRow: 0 },
    { elementId: "water.temperature-text", startRow: 2, startColumn: 0, width: 8 },
    { elementId: "ha-block.characters", startRow: 2, startColumn: 12, width: 3 }
  ];
  await store.save({ ha: { url: "http://ha.local" }, layout: initialLayout,
    haBlock: { enabled: true, entityId: "sensor.living_room_music_vestaboard", unavailableDisplay: "blank" }, updateIntervalMinutes: 3 });
  const clients: FakeHomeAssistantClient[] = [];
  const app = await createApplication(store, directory, true, {
    createHomeAssistantClient: (options) => { const client = new FakeHomeAssistantClient(options); clients.push(client); return asHomeAssistantClient(client); }
  });
  try {
    await app.start(); assert.equal(clients.length, 1);
    const client = clients[0]!;
    const emit = (characters: number[]) => client.emit([{ entity_id: "sensor.living_room_music_vestaboard", state: "ready", attributes: { characters } }]);
    await emit([68, 25, 13]);
    assert.deepEqual(app.actions.status().desired?.characters?.[2]?.slice(12), [68, 25, 13]);
    await emit([69, 25, 13]);
    assert.deepEqual(app.actions.status().desired?.characters?.[2]?.slice(12), [69, 25, 13]);
    const before = store.get();
    const expanded = { ...before.haBlocks[0]!, width: 4 };
    const newLayout = initialLayout.map((entry) => entry.elementId === "ha-block.characters" ? { ...entry, startColumn: 11, width: 4 } : entry);
    const preview = app.actions.preview({ layout: newLayout, haBlocks: [expanded], board: "note" });
    assert.deepEqual(preview.characters?.[2]?.slice(11), [69, 25, 13, 0]);
    assert.deepEqual(store.get(), before);
    await assert.rejects(app.actions.save({ haBlocks: [expanded] }), /at least 4/);
    await assert.rejects(app.actions.save({ haBlock: { height: 2 } }), /out of bounds/);
    await assert.rejects(app.actions.save({ layout: initialLayout.map((entry) => entry.elementId === "ha-block.characters" ? { ...entry, startColumn: 7 } : entry) }), /overlaps/);
    assert.deepEqual(store.get(), before);
    await app.actions.save({ haBlocks: [expanded], layout: newLayout });
    assert.equal(store.get().haBlocks[0]!.width, 4);
    assert.equal(store.get().updateLimits[0]!.windowMinutes, 3);
    assert.equal(clients.length, 1);
    client.setConnected(false); await client.emit([]);
    assert.deepEqual(app.actions.status().desired?.characters?.[2]?.slice(11), [0, 0, 0, 0]);
    assert.ok(app.actions.status().haBlocks?.characters?.error);
    await app.actions.save({ haBlock: { unavailableDisplay: "na" } });
    assert.deepEqual(app.actions.status().desired?.characters?.[2]?.slice(11), [14, 59, 1, 0]);
    client.setConnected(true); await emit([0, 0, 0]);
    assert.deepEqual(app.actions.status().desired?.characters?.[2]?.slice(11), [0, 0, 0, 0]);
    assert.equal(app.actions.status().haBlocks?.characters?.error, undefined);
    await app.actions.save({ layout: [], haBlock: { width: 22, height: 6 } });
    const catalog = app.actions.elements().elements.find((element) => element.id === "ha-block.characters");
    assert.equal(catalog?.preview.length, 6);
    assert.equal(catalog?.preview[0]?.length, 22);
  } finally { await app.stop(); assert.ok(clients.every((client) => client.stopped)); await rm(directory, { recursive: true, force: true }); }
});

test("multiple HA blocks retain independent sources, diagnostics, and placements across saves", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-ha-blocks-"));
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_BOARD: "note" });
  const first = { enabled: true, id: "music", name: "Music", entityId: "sensor.music", attribute: "characters", width: 3, height: 1, unavailableDisplay: "blank" as const, staleAfterMinutes: 15 };
  const second = { ...first, id: "other", name: "Other", entityId: "sensor.other", attribute: "tiles", unavailableDisplay: "na" as const };
  const layout = [{ elementId: "ha-block.music", startRow: 0, startColumn: 0, width: 3 }, { elementId: "ha-block.other", startRow: 0, startColumn: 4, width: 3 }];
  await store.save({ ha: { url: "http://ha.local" }, haBlocks: [first, second], layout, updateIntervalMinutes: 3 });
  const clients: FakeHomeAssistantClient[] = [];
  const app = await createApplication(store, directory, true, {
    createHomeAssistantClient: (options) => { const client = new FakeHomeAssistantClient(options); clients.push(client); return asHomeAssistantClient(client); }
  });
  try {
    await app.start(); assert.equal(clients.length, 1);
    const client = clients[0]!;
    const other: HAEntity = { entity_id: "sensor.other", state: "ready", attributes: { tiles: [1, 2, 3] } };
    await client.emit([{ entity_id: "sensor.music", state: "ready", attributes: { characters: [68, 25, 13] } }, other]);
    assert.deepEqual(app.actions.status().desired?.characters?.[0]?.slice(0, 7), [68, 25, 13, 0, 1, 2, 3]);
    await client.emit([other]);
    assert.deepEqual(app.actions.status().desired?.characters?.[0]?.slice(0, 7), [0, 0, 0, 0, 1, 2, 3]);
    assert.ok(app.actions.status().haBlocks?.music?.error);
    assert.equal(app.actions.status().haBlocks?.other?.error, undefined);
    const before = store.get();
    await assert.rejects(app.actions.save({ haBlocks: [first, { ...second, id: "music" }] }), /unique/);
    await assert.rejects(app.actions.save({ haBlocks: [first], layout }), /unknown element/);
    assert.deepEqual(store.get(), before);
    const draft = app.actions.preview({ haBlocks: [{ ...first, id: "draft", name: "Draft" }], layout: [{ elementId: "ha-block.draft", startRow: 2, width: 3 }] });
    assert.equal(draft.characters?.[2]?.length, 15);
    assert.deepEqual(store.get(), before);
    await app.actions.save({ haBlocks: [second], layout: [layout[1]!] });
    assert.deepEqual(Object.keys(app.actions.status().haBlocks ?? {}), ["other"]);
    assert.equal(app.actions.elements().elements.filter((element) => element.id.startsWith("ha-block.")).length, 1);
    assert.equal(store.get().updateLimits[0]!.windowMinutes, 3);
    assert.equal(clients.length, 1);
  } finally { await app.stop(); assert.ok(clients.every((client) => client.stopped)); await rm(directory, { recursive: true, force: true }); }
});

test("priority drafts and saved output distinguish inactive, paused and unavailable music", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-priority-draft-"));
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture" });
  const music = { id: "music", name: "Music", enabled: true, entityId: "sensor.music", attribute: "characters", width: 15, height: 1,
    activityAttribute: "active", textAttribute: "media_title", textEntityId: "media_player.music", unavailableDisplay: "blank" as const, staleAfterMinutes: 15 };
  await store.save({ board: "note", updateIntervalMinutes: 3, ha: { url: "http://ha.test" },
    water: { enabled: true, remaining: { constant: 40 }, capacity: { constant: 80 }, temperature: { constant: 120 }, target: { constant: 140 } },
    haBlocks: [music], layout: [{ elementId: "water.temperature-text", startRow: 2, width: 8, priority: 0 },
      { elementId: "ha-block.music", startRow: 2, width: 15, priority: 100 }] });
  let client!: FakeHomeAssistantClient; let clients = 0;
  const app = await createApplication(store, directory, true, { createHomeAssistantClient: (options) => { clients++; client = new FakeHomeAssistantClient(options); return asHomeAssistantClient(client); } });
  const emit = async (active: boolean, color: number, title: string) => client.emit([
    { entity_id: "sensor.music", state: "ready", attributes: { active, characters: [10, 26, color] } },
    { entity_id: "media_player.music", state: "paused", attributes: { media_title: title } },
    { entity_id: "media_player.draft", state: "playing", attributes: { media_title: "Draft title" } }
  ]);
  try {
    await app.start(); await emit(true, 68, "1989");
    assert.match(app.actions.status().desired!.text, /JZ 1989/);
    assert.deepEqual(app.actions.status().layoutSelection!.map((entry) => entry.reason), ["suppressed", "shown"]);
    await emit(true, 69, "Beyoncé — Song");
    assert.equal(app.actions.status().desired!.characters![2]![2], 69);
    assert.match(app.actions.status().desired!.text, /JZ BEYONCE/);
    await emit(false, 0, "TV");
    assert.match(app.actions.status().desired!.text, /120\/140F/);
    assert.deepEqual(app.actions.status().layoutSelection!.map((entry) => entry.reason), ["shown", "inactive"]);
    const before = store.get();
    const draft = { ...music, textEntityId: "media_player.draft", activityAttribute: undefined };
    const preview = app.actions.preview({ haBlocks: [draft], layout: before.layout!, board: "note" });
    assert.match(preview.text, /JZ DRAFT TIT/);
    assert.equal(preview.selection![0]!.reason, "suppressed");
    assert.deepEqual(store.get(), before, "draft source/eligibility do not change saved settings");
    await assert.rejects(app.actions.save({ haBlocks: [{ ...music, width: 22 }] }), /at least 22/);
    assert.deepEqual(store.get(), before, "inactive geometry fails atomically");
    await app.actions.save({ haBlocks: [draft] });
    await emit(false, 0, "TV");
    assert.match(app.actions.status().desired!.text, /DRAFT TIT/);
    client.setConnected(false); await client.emit([]);
    assert.equal(app.actions.status().layoutSelection![1]!.state, "unavailable");
    assert.equal(app.actions.status().layoutSelection![1]!.reason, "shown");
    assert.deepEqual(app.actions.status().desired!.characters![2], Array(15).fill(0));
    assert.equal(clients, 1); assert.equal(store.get().updateLimits[0]!.windowMinutes, 3);
  } finally { await app.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("bar row draft preview, atomic save and removal preserve temperature/music priority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-bar-row-application-"));
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture" });
  const row = BarRowConfigSchema.parse({ id: "hot-water", name: "Hot water", enabled: true,
    source: { kind: "entity", entityId: "sensor.hot_water_display" } });
  const music = { id: "music", name: "Music", enabled: true, entityId: "sensor.music", attribute: "characters", width: 15, height: 1,
    activityAttribute: "active", unavailableDisplay: "blank" as const, staleAfterMinutes: 15 };
  const oldLayout = [{ elementId: "water.remaining", startRow: 1, width: 15 },
    { elementId: "water.temperature-text", startRow: 2, width: 8, priority: 0 },
    { elementId: "ha-block.music", startRow: 2, width: 15, priority: 100 }];
  await store.save({ board: "note", ha: { url: "http://ha.test" }, codex: { enabled: false },
    water: { enabled: true, remaining: { constant: 61.5 }, capacity: { constant: 100 }, temperature: { constant: 120 }, target: { constant: 140 } },
    haBlocks: [music], layout: oldLayout });
  let client!: FakeHomeAssistantClient; let sends = 0;
  const app = await createApplication(store, directory, true, {
    createVestaboardClient: () => ({ send: async () => { sends++; } }),
    createHomeAssistantClient: (options) => { client = new FakeHomeAssistantClient(options); return asHomeAssistantClient(client); }
  });
  const emit = (active: boolean, display_text = "3S") => client.emit([
    { entity_id: "sensor.hot_water_display", state: "ready", attributes: { display_name: "HW", current: 61.5, max: 100, display_text } },
    { entity_id: "sensor.music", state: "ready", attributes: { active, characters: [10, 26, 69] } }
  ]);
  try {
    await app.start(); await emit(true);
    const before = store.get(); const statusBefore = app.actions.status().barRows; const sendsBefore = sends;
    const layout = [{ ...oldLayout[0]!, elementId: "bar-row.hot-water" }, ...oldLayout.slice(1)];
    const preview = app.actions.preview({ board: "note", layout, barRows: [row] });
    assert.deepEqual(preview.characters[1], [...encode("HW"), ...Array(7).fill(67), ...Array(3).fill(0), ...encode("3S ")]);
    assert.equal(preview.barRows!['hot-water']!.state, "active");
    assert.deepEqual(preview.selection!.map((entry) => entry.reason), ["shown", "suppressed", "shown"]);
    assert.deepEqual(store.get(), before); assert.deepEqual(app.actions.status().barRows, statusBefore); assert.equal(sends, sendsBefore);
    const invalidPreview = app.actions.preview({ layout, barRows: [{ ...row, textWidth: 1 }] });
    assert.match(invalidPreview.barRows!['hot-water']!.inputs.displayText.error!, /reserved 1 cells/);
    await assert.rejects(app.actions.save({ barRows: [row], layout: [{ ...layout[0]!, width: 5 }] }), /at least 6/);
    assert.deepEqual(store.get(), before);
    await app.actions.save({ barRows: [row], layout });
    assert.deepEqual(app.actions.status().desired!.characters![1], preview.characters[1]);
    assert.equal(app.actions.status().barRows!['hot-water']!.state, "active");
    assert.deepEqual(store.get().water, before.water); assert.deepEqual(store.get().haBlocks, before.haBlocks);
    await emit(false); assert.match(app.actions.status().desired!.text, /120\/140F/);
    await emit(false, "100S"); assert.equal(app.actions.status().barRows!['hot-water']!.state, "unavailable");
    assert.deepEqual(app.actions.status().desired!.characters![1]!.slice(0, 3), encode("N/A"));
    await assert.rejects(app.actions.save({ barRows: [] }), /unknown element/);
    await app.actions.save({ barRows: [], layout: oldLayout });
    assert.deepEqual(app.actions.status().barRows, {});
    assert.equal(app.actions.elements().elements.some((element) => element.id === "bar-row.hot-water"), false);
    assert.match(app.actions.status().desired!.text, /62G/);
  } finally { await app.stop(); await rm(directory, { recursive: true, force: true }); }
});
