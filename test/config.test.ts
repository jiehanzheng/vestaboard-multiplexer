import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigStore, DEFAULT_APP_CONFIG, type AppConfig } from "../src/config.js";
import { ConfigPatchSchema } from "../src/contracts/config.js";

test("loads Home Assistant without retired water defaults", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const store = await ConfigStore.open(dataDir, {});
  assert.deepEqual(store.get().ha, { url: "", pause: null });
  assert.equal("water" in store.get(), false);
  assert.equal(store.getPublic().hasSecrets.haToken, false);
  assert.equal(store.get().transport.pauseMessageTransition, undefined);
});

test("persists and clears the optional local pause animation", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-animation-"));
  try {
    const store = await ConfigStore.open(dataDir, {});
    const transition = { strategy: "diagonal" as const, stepIntervalMs: 750, stepSize: 2 };
    await store.save({ transport: { pauseMessageTransition: transition } });
    assert.deepEqual(store.get().transport.pauseMessageTransition, transition);
    await store.save({ transport: { pauseMessageTransition: null } });
    assert.equal(store.get().transport.pauseMessageTransition, undefined);
  } finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("validates Home Assistant URL, pause mapping", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const store = await ConfigStore.open(dataDir, {});
  await assert.rejects(store.save({ ...DEFAULT_APP_CONFIG, ha: { ...DEFAULT_APP_CONFIG.ha, url: "https://user:pass@ha.local" } }), /embedded credentials/i);
  await assert.rejects(store.save({ ...DEFAULT_APP_CONFIG, ha: { ...DEFAULT_APP_CONFIG.ha, pause: { entityId: "input_boolean.pause", pauseValue: "on", resumeValue: "on" } } }), /differ|distinct/i);
  await assert.rejects(store.save({ ...DEFAULT_APP_CONFIG, ha: null as never }), /ha is required|expected object/i);
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

test("keeps malformed saved layouts invalid and leaves the file untouched", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-invalid-layout-"));
  const raw = JSON.stringify({
    version: 1,
    ...DEFAULT_APP_CONFIG,
    layout: [null, { elementId: "water.temperature-bar", startRow: 0 }]
  });
  await writeFile(join(dataDir, "config.json"), raw);
  const store = await ConfigStore.open(dataDir, {});
  assert.match(store.repairError ?? "", /layout/i);
  assert.equal(await readFile(join(dataDir, "config.json"), "utf8"), raw);
  assert.equal(store.get().layout, null);
});

test("malformed configuration diagnostics do not expose raw credential text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-config-secret-"));
  try {
    await writeFile(join(directory, "config.json"), "secret-token-that-must-stay-private");
    const store = await ConfigStore.open(directory, {});
    assert.equal(store.getPublic().error, "Saved configuration is not valid JSON.");
    assert.ok(!JSON.stringify(store.getPublic()).includes("secret-token"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("opens defaults when no config file exists and imports legacy environment once", async () => {
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
  assert.deepEqual(publicConfig.legacyEnvironmentVariables, ["VESTABOARD_BOARD", "VESTABOARD_TOKEN", "CODEX_QUOTA_SHOW_PACING"]);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, "config.json"), "utf8")).codex.showPacing, false);
});

test("first-run legacy import remains authoritative on later opens", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const first = await ConfigStore.open(dataDir, { VESTABOARD_BOARD: "flagship" });
  assert.equal(first.get().board, "flagship");
  const second = await ConfigStore.open(dataDir, { VESTABOARD_BOARD: "note" });
  assert.equal(second.get().board, "flagship");
  assert.deepEqual(second.getPublic().legacyEnvironmentVariables, ["VESTABOARD_BOARD"]);
});

test("invalid legacy booleans identify the variable without exposing its value", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const invalidValue = "not-a-boolean-secret";
  const store = await ConfigStore.open(dataDir, { CODEX_QUOTA_SHOW_PACING: invalidValue });
  const error = store.getPublic().error ?? "";
  assert.match(error, /CODEX_QUOTA_SHOW_PACING/);
  assert.doesNotMatch(error, new RegExp(invalidValue));
  await assert.rejects(readFile(join(dataDir, "config.json")));
});

test("operational and auth mount variables are excluded from legacy warnings", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const store = await ConfigStore.open(dataDir, {
    VBMUX_HOST: "127.0.0.1",
    VBMUX_PORT: "31337",
    VBMUX_DATA_DIR: "/other/data",
    CODEX_HOST_DIR: "/private/auth",
    CODEX_HOME: "/private/home"
  });
  assert.deepEqual(store.getPublic().legacyEnvironmentVariables, []);
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

test("existing config remains authoritative when legacy environment variables are present", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const initial = await ConfigStore.open(dataDir, {});
  await initial.save({ ...DEFAULT_APP_CONFIG, updateIntervalMinutes: 5 });

  const existing = await ConfigStore.open(dataDir, { ORCHESTRATOR_INTERVAL_MINUTES: "10" });
  assert.equal(existing.get().updateLimits[0]!.windowMinutes, 5);
  assert.deepEqual(existing.getPublic().legacyEnvironmentVariables, ["ORCHESTRATOR_INTERVAL_MINUTES"]);
  await existing.save({ ...existing.get(), layout: [] });

  const reopened = await ConfigStore.open(dataDir, {});
  assert.equal(reopened.get().updateLimits[0]!.windowMinutes, 5);
  assert.deepEqual(reopened.get().layout, []);
});

test("drops obsolete saved demo configuration and normalizes it on the next save", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const saved = { ...DEFAULT_APP_CONFIG, codex: { ...DEFAULT_APP_CONFIG.codex, demoPauseMinutes: 5 } };
  await writeFile(join(dataDir, "config.json"), JSON.stringify({ version: 1, ...saved }), "utf8");
  const store = await ConfigStore.open(dataDir, {});
  assert.equal(store.getPublic().error, undefined);
  assert.equal("demoPauseMinutes" in store.get().codex, false);
  await store.save(store.get());
  assert.equal("demoPauseMinutes" in JSON.parse(await readFile(join(dataDir, "config.json"), "utf8")).codex, false);
});

test("warns for obsolete environment variables without exposing their values", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    await ConfigStore.open(dataDir, { CODEX_QUOTA_PRIORITY: "urgent-secret", CODEX_QUOTA_DEMO_PAUSE_MINUTES: "9" });
  } finally { console.warn = originalWarn; }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /CODEX_QUOTA_PRIORITY/);
  assert.match(warnings[0]!, /CODEX_QUOTA_DEMO_PAUSE_MINUTES/);
  assert.ok(!warnings[0]!.includes("urgent-secret"));
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
  assert.deepEqual(store.get().pauseOverlay, DEFAULT_APP_CONFIG.pauseOverlay);
});

test("pause overlay defaults survive old configs and partial patches preserve the other board", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-overlay-"));
  const store = await ConfigStore.open(dataDir, {});
  const flagship = structuredClone(store.get().pauseOverlay.flagship);
  flagship[0]![0] = 1;
  await store.save({ pauseOverlay: { flagship } });
  assert.equal(store.get().pauseOverlay.flagship[0]?.[0], 1);
  assert.deepEqual(store.get().pauseOverlay.note, DEFAULT_APP_CONFIG.pauseOverlay.note);
  const reopened = await ConfigStore.open(dataDir, {});
  assert.equal(reopened.get().pauseOverlay.flagship[0]?.[0], 1);
  assert.deepEqual(reopened.get().pauseOverlay.note, DEFAULT_APP_CONFIG.pauseOverlay.note);
});

test("pause overlay rejects invalid dimensions and code 71", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-overlay-invalid-"));
  const store = await ConfigStore.open(dataDir, {});
  await assert.rejects(store.save({ pauseOverlay: { note: [[71]] } }), /pauseOverlay|pause overlay/i);
  assert.deepEqual(store.get().pauseOverlay, DEFAULT_APP_CONFIG.pauseOverlay);
});

test("rejects invalid time zones before writing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "vbmux-config-"));
  const store = await ConfigStore.open(dataDir, {});
  await assert.rejects(
    store.save({ ...DEFAULT_APP_CONFIG, codex: { ...DEFAULT_APP_CONFIG.codex, timeZone: "Not/AZone" } }),
    /time zone/i
  );
});

test("retired water settings and placements are private, preserved without read rewrites, and explicitly removable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-retired-water-"));
  try {
    const path = join(directory, "config.json");
    const water = { token: "private-retired-token", arbitrary: [null, 42] };
    const placements = [{ elementId: "water.temperature-bar", nonsense: true }, { elementId: "water.remaining", startRow: "invalid" }];
    const supported = { elementId: "codex.window-1-small", startRow: 0 };
    const raw = JSON.stringify({ version: 1, ...DEFAULT_APP_CONFIG, water, layout: [placements[0], supported, placements[1]] });
    await writeFile(path, raw);
    let store = await ConfigStore.open(directory, {});
    assert.equal(store.repairError, undefined); assert.equal(await readFile(path, "utf8"), raw);
    assert.deepEqual(store.get().layout, [supported]); assert.equal("water" in store.get(), false);
    const warning = [{ id: "water", settingsPresent: true, elementIds: ["water.temperature-bar", "water.remaining"] }];
    assert.deepEqual(store.getPublic().ignoredPlugins, warning);
    assert.equal(JSON.stringify(store.getPublic()).includes("private-retired-token"), false);
    await store.save({ board: "note" });
    let persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal("water" in persisted, false); assert.deepEqual(persisted.retiredPlugins.records[0].settings, water); assert.deepEqual(persisted.layout, [supported]);
    assert.deepEqual(persisted.retiredPlugins.records[0].placements.map((entry: { value: unknown }) => entry.value), placements);
    store = await ConfigStore.open(directory, {}); assert.deepEqual(store.getPublic().ignoredPlugins, warning);
    const replacement = { elementId: "codex.window-2-small", startRow: 1 };
    await store.save({ layout: [replacement] });
    persisted = JSON.parse(await readFile(path, "utf8")); assert.deepEqual(persisted.layout, [replacement]);
    await store.save({ board: "flagship" });
    persisted = JSON.parse(await readFile(path, "utf8")); assert.deepEqual(persisted.layout, [replacement]);
    store = await ConfigStore.open(directory, {});
    await store.save({ removeUnsupportedPlugins: true });
    persisted = JSON.parse(await readFile(path, "utf8")); assert.equal("water" in persisted, false);
    assert.deepEqual(persisted.layout, [replacement]); assert.equal("removeUnsupportedPlugins" in persisted, false); assert.equal("retiredPlugins" in persisted, false);
    store = await ConfigStore.open(directory, {}); assert.deepEqual(store.getPublic().ignoredPlugins, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("retirement recognition does not weaken strict supported validation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-retired-strict-"));
  try {
    for (const extra of [{ otherPlugin: {} }, { layout: [{ elementId: "other.element", startRow: "bad" }] }, { barRows: "invalid" }]) {
      const raw = JSON.stringify({ version: 1, ...DEFAULT_APP_CONFIG, water: null, ...extra });
      await writeFile(join(directory, "config.json"), raw);
      const store = await ConfigStore.open(directory, {}); assert.ok(store.repairError);
      assert.equal(await readFile(join(directory, "config.json"), "utf8"), raw);
    }
    assert.equal(ConfigPatchSchema.safeParse({ water: {} }).success, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed cleanup persistence retains the retirement warning and original payload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-retired-failure-"));
  try {
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ version: 1, ...DEFAULT_APP_CONFIG, water: { original: true } }));
    const store = await ConfigStore.open(directory, {});
    await store.save({ board: "note" });
    assert.ok(JSON.parse(await readFile(path, "utf8")).retiredPlugins);
    await rm(path); await mkdir(path);
    await assert.rejects(store.save({ removeUnsupportedPlugins: true }));
    assert.equal(store.getPublic().ignoredPlugins.length, 1);
    await rm(path, { recursive: true }); await store.save({ board: "note" });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")).retiredPlugins.records[0].settings, { original: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("retirement warnings distinguish settings-only and placements-only saved files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-retired-metadata-"));
  try {
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ version: 1, ...DEFAULT_APP_CONFIG, water: null }));
    let store = await ConfigStore.open(directory, {});
    assert.deepEqual(store.getPublic().ignoredPlugins, [{ id: "water", settingsPresent: true, elementIds: [] }]);
    await writeFile(path, JSON.stringify({ version: 1, ...DEFAULT_APP_CONFIG, layout: [{ elementId: "water.custom", startRow: null }, { elementId: "water.custom", startRow: 2 }] }));
    store = await ConfigStore.open(directory, {});
    assert.deepEqual(store.getPublic().ignoredPlugins, [{ id: "water", settingsPresent: false, elementIds: ["water.custom"] }]);
    await store.save({ removeUnsupportedPlugins: false });
    assert.equal(JSON.parse(await readFile(path, "utf8")).retiredPlugins.records[0].placements.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("private archive preserves null and exact supported layouts across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-retired-null-"));
  try {
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify({ version: 1, ...DEFAULT_APP_CONFIG, water: { private: true }, layout: [{ elementId: "water.remaining", invalid: true }] }));
    let store = await ConfigStore.open(directory, {});
    await store.save({ layout: null });
    store = await ConfigStore.open(directory, {});
    assert.equal(store.get().layout, null); assert.equal(JSON.parse(await readFile(path, "utf8")).layout, null);
    assert.equal(store.getPublic().ignoredPlugins.length, 1);
    const layout = [{ elementId: "codex.window-1-small", startRow: 2, priority: 10 }];
    await store.save({ layout }); store = await ConfigStore.open(directory, {});
    assert.deepEqual(store.get().layout, layout);
    await store.save({ removeUnsupportedPlugins: true }); store = await ConfigStore.open(directory, {});
    assert.deepEqual(store.get().layout, layout); assert.deepEqual(store.getPublic().ignoredPlugins, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("coexisting historical and archive records deduplicate exact records and preserve distinct records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-retired-coexist-"));
  try {
    const path = join(directory, "config.json");
    const placement = { elementId: "water.remaining", startRow: 1 };
    const record = { id: "water", settingsPresent: true, settings: { original: 1 }, placements: [{ index: 0, value: placement }] };
    await writeFile(path, JSON.stringify({ version: 1, ...DEFAULT_APP_CONFIG, water: { original: 1 }, layout: [placement], retiredPlugins: { version: 1, records: [record, record] } }));
    let store = await ConfigStore.open(directory, {}); assert.equal(store.repairError, undefined);
    await store.save({ board: "note" });
    assert.equal(JSON.parse(await readFile(path, "utf8")).retiredPlugins.records.length, 1);
    const raw = JSON.parse(await readFile(path, "utf8")); raw.water = { original: 2 }; raw.layout = [placement];
    await writeFile(path, JSON.stringify(raw)); store = await ConfigStore.open(directory, {});
    await store.save({ board: "flagship" });
    assert.equal(JSON.parse(await readFile(path, "utf8")).retiredPlugins.records.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("private archive envelopes remain strict while archived obsolete payloads are unconstrained", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-retired-envelope-"));
  try {
    for (const retiredPlugins of [{ version: 2, records: [] }, { version: 1, records: [{ id: "unknown", settingsPresent: true, placements: [] }] },
      { version: 1, records: [{ id: "water", settingsPresent: "yes", placements: [] }] },
      { version: 1, records: [{ id: "water", settingsPresent: false, placements: [{ index: 0, value: { elementId: "other.element" } }] }] }]) {
      await writeFile(join(directory, "config.json"), JSON.stringify({ version: 1, ...DEFAULT_APP_CONFIG, retiredPlugins }));
      const store = await ConfigStore.open(directory, {}); assert.ok(store.repairError);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
