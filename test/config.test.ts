import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigStore, DEFAULT_APP_CONFIG } from "../src/config.js";

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
  assert.deepEqual(publicConfig.hasSecrets, { token: true, localApiKey: false });
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
  assert.equal(existing.get().updateIntervalMinutes, 5);
  assert.deepEqual(existing.getPublic().legacyEnvironmentVariables, ["ORCHESTRATOR_INTERVAL_MINUTES"]);
  await existing.save({ ...existing.get(), layout: [] });

  const reopened = await ConfigStore.open(dataDir, {});
  assert.equal(reopened.get().updateIntervalMinutes, 5);
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
