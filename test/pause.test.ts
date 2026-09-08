import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PauseController, PauseStore } from "../src/pause.js";
import type { HomeAssistantServiceLike, HomeAssistantSnapshot, HomeAssistantSnapshotListener } from "../src/homeAssistantService.js";

class FakeHomeAssistantService implements HomeAssistantServiceLike {
  private readonly listeners = new Set<HomeAssistantSnapshotListener>();
  private current: HomeAssistantSnapshot = { source: "", entities: [], connected: false };

  configure(): void {}
  start(): void {}
  async collectInitial(): Promise<void> {}
  async inspect(): Promise<{ connected: boolean }> { return { connected: this.current.connected }; }
  async stop(): Promise<void> {}
  snapshot(): HomeAssistantSnapshot { return this.current; }
  subscribe(listener: HomeAssistantSnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  publish(snapshot: HomeAssistantSnapshot): void {
    this.current = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}

test("HA pause belongs to its binding across restart and combines with manual pause", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vbmux-pause-"));
  try {
    let pause = await PauseStore.open(dir);
    await pause.bindHA("first");
    assert.equal(pause.status().paused, true);
    await pause.setHA(false, "first");
    assert.equal(pause.status().paused, false);
    await pause.setManual(true);
    pause = await PauseStore.open(dir);
    await pause.bindHA("first");
    assert.deepEqual(pause.status(), { manualPause: true, haPause: false, paused: true });
    await pause.setManual(false);
    await pause.bindHA("second");
    await pause.setHA(false, "first");
    assert.equal(pause.status().haPause, true);
    await pause.setHA(false, "second");
    assert.equal(pause.status().paused, false);
    await pause.setHA(true, "second");
    pause = await PauseStore.open(dir);
    await pause.bindHA("second");
    assert.equal(pause.status().haPause, true);
    await pause.bindHA(undefined);
    assert.equal(pause.status().paused, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a newer pause request remains latched while an older persistence write completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vbmux-pause-race-"));
  try {
    const pause = await PauseStore.open(dir);
    await pause.setManual(true);
    const resume = pause.setManual(false);
    const relatch = pause.setManual(true);
    assert.equal(pause.status().paused, true);
    await resume;
    assert.equal(pause.status().paused, true);
    await relatch;
    assert.equal(pause.status().paused, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("independent manual and HA writes keep their latest requested values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vbmux-pause-independent-"));
  try {
    const pause = await PauseStore.open(dir);
    await pause.bindHA("first");
    await pause.setHA(false, "first");
    await pause.setManual(true);
    const resumeManual = pause.setManual(false);
    const pauseFromHA = pause.setHA(true, "first");
    assert.equal(pause.status().paused, true);
    await Promise.all([resumeManual, pauseFromHA]);
    assert.deepEqual(pause.status(), { manualPause: false, haPause: true, paused: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a later HA write preserves a manual pause after an earlier write failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vbmux-pause-failure-"));
  try {
    const pause = await PauseStore.open(dir);
    await pause.bindHA("first");
    await pause.setHA(false, "first");
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, "blocked");
    await assert.rejects(pause.setManual(true));
    await rm(dir, { force: true });
    await mkdir(dir);
    await pause.setHA(true, "first");
    const reopened = await PauseStore.open(dir);
    assert.equal(reopened.status().manualPause, true);
    assert.equal(reopened.status().haPause, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("retrying a failed binding persists the same requested binding", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vbmux-pause-binding-retry-"));
  try {
    const pause = await PauseStore.open(dir);
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, "blocked");
    await assert.rejects(pause.bindHA("first"));
    await rm(dir, { force: true });
    await mkdir(dir);
    await pause.bindHA("first");
    await pause.setHA(false, "first");
    assert.equal(pause.status().paused, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("controller consumes exact HA pause states and ignores ordinary HA outages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vbmux-pause-controller-"));
  const service = new FakeHomeAssistantService();
  try {
    const controller = await PauseController.open(dir, service);
    await controller.configure({ url: "http://ha.local:8123", pause: { entityId: "input_boolean.pause", pauseValue: "on", resumeValue: "off" } });
    assert.equal(controller.status().paused, true);
    service.publish({ source: "http://ha.local:8123", connected: true, entities: [{ entity_id: "input_boolean.pause", state: "off", attributes: {} }] });
    await controller.flush();
    assert.equal(controller.status().paused, false);
    service.publish({ source: "http://other.local:8123", connected: true, entities: [{ entity_id: "input_boolean.pause", state: "on", attributes: {} }] });
    await controller.flush();
    assert.equal(controller.status().paused, false);
    service.publish({ source: "http://ha.local:8123", connected: false, error: "connection closed", entities: [] });
    await controller.flush();
    assert.equal(controller.status().paused, false);
    service.publish({ source: "http://ha.local:8123", connected: true, entities: [{ entity_id: "input_boolean.pause", state: "on", attributes: {} }] });
    await controller.flush();
    assert.equal(controller.status().paused, true);
    await controller.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("corrupt pause state stays paused until a successful repair", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vbmux-pause-corrupt-"));
  try {
    await writeFile(join(dir, "pause.json"), "not-json");
    const controller = await PauseController.open(dir, new FakeHomeAssistantService());
    assert.equal(controller.status().paused, true);
    assert.match(controller.status().persistenceError ?? "", /invalid/i);
    await controller.configure({ url: "", pause: null });
    await controller.manual(false);
    assert.equal(controller.status().paused, false);
    assert.equal(controller.status().persistenceError, undefined);
    await controller.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a manual-only pause file upgrades with an inactive HA pause", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vbmux-pause-upgrade-"));
  try {
    await writeFile(join(dir, "pause.json"), JSON.stringify({ manualPause: true }));
    const pause = await PauseStore.open(dir);
    assert.deepEqual(pause.status(), { manualPause: true, haPause: false, paused: true });
    await pause.setManual(false);
    assert.equal(pause.status().paused, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
