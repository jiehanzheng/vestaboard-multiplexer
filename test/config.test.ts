import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigStore, DEFAULT_APP_CONFIG } from "../src/config.js";

test("opens defaults when no config file exists and applies environment locks", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const store = await ConfigStore.open(dataDir, {
    VESTABOARD_BOARD: "flagship",
    VESTABOARD_TOKEN: "secret",
    CODEX_QUOTA_SHOW_PACING: "off"
  });

  assert.equal(store.get().board, "flagship");
  assert.equal(store.get().codex.showPacing, false);
  const publicConfig = store.getPublic();
  assert.equal("token" in publicConfig.config.transport, false);
  assert.deepEqual(publicConfig.hasSecrets, { token: true, localApiKey: false, haToken: false });
  assert.deepEqual(publicConfig.locked, ["board", "transport.token", "codex.showPacing"]);
});

test("save persists versioned JSON, preserves omitted secrets, and allows explicit clears", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const first = await ConfigStore.open(dataDir, {});
  await first.save({ ...DEFAULT_APP_CONFIG, transport: { ...DEFAULT_APP_CONFIG.transport, token: "secret" } });
  const second = await ConfigStore.open(dataDir, {});
  await second.save({ ...second.get(), board: "note", transport: { ...second.get().transport } });
  assert.equal(second.get().transport.token, "secret");
  const persisted = JSON.parse(await readFile(join(dataDir, "config.json"), "utf8")) as { version: number };
  assert.equal(persisted.version, 1);

  await second.save({ ...second.get(), transport: { ...second.get().transport, token: "" } });
  assert.equal(second.get().transport.token, "");
});

test("does not persist environment overrides when saving effective UI values", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const initial = await ConfigStore.open(dataDir, {});
  await initial.save({ ...DEFAULT_APP_CONFIG, updateIntervalMinutes: 5 });

  const locked = await ConfigStore.open(dataDir, { ORCHESTRATOR_INTERVAL_MINUTES: "10" });
  assert.equal(locked.get().updateIntervalMinutes, 10);
  await locked.save({ ...locked.get(), layout: [] });

  const reopened = await ConfigStore.open(dataDir, {});
  assert.equal(reopened.get().updateIntervalMinutes, 5);
  assert.deepEqual(reopened.get().layout, []);
});

test("invalid saved config is reported without overwriting it", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const filePath = join(dataDir, "config.json");
  const invalid = JSON.stringify({ version: 1, board: "not-a-board" });
  await writeFile(filePath, invalid, "utf8");
  const store = await ConfigStore.open(dataDir, {});
  assert.match(store.getPublic().error ?? "", /board/);
  assert.equal(await readFile(filePath, "utf8"), invalid);
});

test("merges defaults into a minimal versioned saved config", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  await writeFile(join(dataDir, "config.json"), JSON.stringify({ version: 1, layout: null }), "utf8");
  const store = await ConfigStore.open(dataDir, {});
  assert.equal(store.getPublic().error, undefined);
  assert.equal(store.get().transport.cloudUrl, DEFAULT_APP_CONFIG.transport.cloudUrl);
  assert.equal(store.get().codex.pollIntervalSeconds, DEFAULT_APP_CONFIG.codex.pollIntervalSeconds);
});

test("rejects invalid time zones before writing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const store = await ConfigStore.open(dataDir, {});
  await assert.rejects(
    store.save({ ...DEFAULT_APP_CONFIG, codex: { ...DEFAULT_APP_CONFIG.codex, timeZone: "Not/AZone" } }),
    /time zone/i
  );
});

test("loads Home Assistant and disabled water defaults", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const store = await ConfigStore.open(dataDir, {});
  assert.deepEqual(store.get().ha, { url: "", pause: null });
  assert.deepEqual(store.get().water, {
    remaining: null,
    capacity: null,
    temperature: null,
    target: null,
    unit: "F",
    enabled: false
  });
  assert.equal(store.getPublic().hasSecrets.haToken, false);
});

test("validates Home Assistant URL, pause mapping, and numeric water sources", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const store = await ConfigStore.open(dataDir, {});
  await assert.rejects(store.save({ ...DEFAULT_APP_CONFIG, ha: { ...DEFAULT_APP_CONFIG.ha, url: "https://user:pass@ha.local" } }), /embedded credentials/i);
  await assert.rejects(store.save({ ...DEFAULT_APP_CONFIG, ha: { ...DEFAULT_APP_CONFIG.ha, pause: { entityId: "input_boolean.pause", pauseValue: "on", resumeValue: "on" } } }), /differ|distinct/i);
  await assert.rejects(store.save({ ...DEFAULT_APP_CONFIG, ha: null as never }), /ha is required|expected object/i);
  await assert.rejects(store.save({ ...DEFAULT_APP_CONFIG, water: { ...DEFAULT_APP_CONFIG.water, capacity: { constant: 0 } } }), /water\.capacity.*positive/i);
  await assert.rejects(store.save({ ...DEFAULT_APP_CONFIG, water: { ...DEFAULT_APP_CONFIG.water, temperature: { entityId: "" } } }), /water\.temperature.*entity/i);
});

test("preserves and redacts an omitted Home Assistant token", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const first = await ConfigStore.open(dataDir, {});
  await first.save({ ...DEFAULT_APP_CONFIG, ha: { ...DEFAULT_APP_CONFIG.ha, url: "http://ha.local:8123", token: "ha-secret" } });
  const second = await ConfigStore.open(dataDir, {});
  assert.equal("token" in second.getPublic().config.ha, false);
  assert.equal(second.getPublic().hasSecrets.haToken, true);
  await second.save({ ...second.get(), ha: { ...second.get().ha, token: undefined } });
  assert.equal(second.get().ha.token, "ha-secret");
});

test("requires a baseline only when the water temperature bar is allocated", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const store = await ConfigStore.open(dataDir, {});
  const textOnly = {
    ...DEFAULT_APP_CONFIG,
    water: { ...DEFAULT_APP_CONFIG.water, enabled: true, temperature: { constant: 125 }, target: { constant: 135 } },
    layout: [{ elementId: "water.temperature-text", startRow: 0 }]
  };
  await store.save(textOnly);
  await assert.rejects(store.save({ ...textOnly, layout: [{ elementId: "water.temperature-bar", startRow: 0 }] }), /water\.baseline/i);
  await store.save({ ...textOnly, water: { ...textOnly.water, baseline: 50 }, layout: [{ elementId: "water.temperature-bar", startRow: 0 }] });
});
