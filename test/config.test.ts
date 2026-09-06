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
  assert.equal(publicConfig.config.transport.token, undefined);
  assert.deepEqual(publicConfig.hasSecrets, { token: true, localApiKey: false });
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
