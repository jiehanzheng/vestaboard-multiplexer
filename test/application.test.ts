import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, type PublicConfig } from "../src/config.js";
import { createApplication } from "../src/application.js";
import type { HAEntity, HomeAssistantClient, HomeAssistantClientOptions } from "../src/homeAssistant.js";

class FakeHomeAssistantClient {
  private entities: HAEntity[] = [];
  private started = false;
  private connected = false;
  stopped = false;

  constructor(private readonly options: HomeAssistantClientOptions) {}

  start(): void { this.started = true; this.connected = true; }
  stop(): void { this.stopped = true; }
  waitUntilReady(): Promise<void> { return Promise.resolve(); }
  states(): HAEntity[] { return this.entities.map((entity) => ({ ...entity, attributes: { ...entity.attributes } })); }
  status(): { connected: boolean } { return { connected: this.started && !this.stopped && this.connected }; }
  setConnected(value: boolean): void { this.connected = value; }
  async emit(entities: HAEntity[]): Promise<void> {
    this.entities = entities;
    const callback = (this.options.changed as unknown as (() => void | Promise<void>) | undefined)?.();
    if (callback instanceof Promise) await callback;
  }
}

const asHomeAssistantClient = (client: FakeHomeAssistantClient): HomeAssistantClient => client as unknown as HomeAssistantClient;

test("web application can configure an unconnected board and preview without sending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-app-"));
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_BOARD: "note" });
  const app = await createApplication(store, directory, false);
  try {
    await app.start();
    const initial = app.actions.status() as { configError?: string; lastSent?: unknown };
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
        target: { constant: 140 },
        baseline: 80
      }
    });
    const savedWater = store.get().water;

    const elementIds = (app.actions.elements() as { elements: Array<{ id: string }> }).elements.map((element) => element.id);
    assert.deepEqual(elementIds.filter((id) => id.startsWith("water.")), [
      "water.remaining",
      "water.temperature-bar",
      "water.temperature-text"
    ]);
    assert.deepEqual((app.actions.status() as { water?: { error?: string } }).water, {});

    const draftWater = {
      ...before.water,
      enabled: true,
      remaining: { constant: 40 },
      capacity: { constant: 80 },
      temperature: { constant: 125 },
      target: { constant: 135 },
      baseline: 80
    };
    const preview = (app.actions.preview({
      layout: [
        { elementId: "water.remaining", startRow: 0 },
        { elementId: "water.temperature-bar", startRow: 1 },
        { elementId: "water.temperature-text", startRow: 2 }
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

test("same Home Assistant connection applies a newly selected cached pause entity", async () => {
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
    await persistent.emit([{ entity_id: "input_boolean.new", state: "off", attributes: {} }]);
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
