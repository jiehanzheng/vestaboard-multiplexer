import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PauseStore } from "../src/pause.js";
import { startWebServer } from "../src/webServer.js";
import { DEFAULT_APP_CONFIG } from "../src/config.js";

test("pause persists manual and HA values independently and fails paused on corruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-pause-"));
  try {
    const store = await PauseStore.open(directory);
    await store.setHA(true);
    await store.setManual(true);
    await store.setManual(false);
    assert.deepEqual((await PauseStore.open(directory)).status(), { manualPause: false, haPause: true, paused: true });
    await writeFile(join(directory, "pause.json"), "broken");
    assert.equal((await PauseStore.open(directory)).status().paused, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HTTP actions validate JSON/origin and SSE reconnect receives current snapshot", { concurrency: false }, async () => {
  let value = 1;
  let saveCalls = 0;
  const requests: Array<{ action: "test" | "entities"; value: unknown }> = [];
  const status = () => ({ board: "note" as const, nextAttemptAt: value, manualPause: false, haPause: false, paused: false, codex: {}, login: { pending: false } });
  const config = () => ({ config: { ...DEFAULT_APP_CONFIG, transport: { ...DEFAULT_APP_CONFIG.transport, token: "server-only" }, ha: { ...DEFAULT_APP_CONFIG.ha, token: "ha-server-only" } }, legacyEnvironmentVariables: [], hasSecrets: { token: true, localApiKey: false, haToken: true } });
  const server = await startWebServer({
    status, config, elements: () => ({ elements: [], defaultLayout: [] }),
    save: async () => { saveCalls++; return config(); }, preview: () => ({ text: "", characters: [] }), pause: async () => status(), login: async () => ({ pending: false }),
    homeAssistant: async (action, request) => {
      requests.push({ action, value: request });
      return action === "test" ? { connected: true } : { entities: [] };
    }
  }, { port: Number(process.env.VBMUX_TEST_PORT ?? 0), host: "127.0.0.1" });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    assert.equal((await fetch(`${url}/api/config`, { method: "POST", headers: { "content-type": "application/json", origin: "http://elsewhere" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${url}/api/config`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status, 400);
    assert.equal((await fetch(`${url}/api/config`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"water":{"remaining":42}}' })).status, 400);
    assert.equal(saveCalls, 0);
    const publicConfig = await (await fetch(`${url}/api/config`)).text();
    assert.ok(!publicConfig.includes("server-only"));
    for (const expected of [1, 2]) {
      value = expected;
      const abort = new AbortController();
      const response = await fetch(`${url}/api/events`, { signal: abort.signal, headers: { connection: "close" } });
      const reader = response.body!.getReader();
      const chunk = await reader.read();
      assert.match(new TextDecoder().decode(chunk.value), new RegExp(`"nextAttemptAt":${expected}`));
      abort.abort();
      await reader.cancel().catch(() => {});
    }
    const omitted = await fetch(`${url}/api/ha/test`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://ha.local:8123" })
    });
    assert.equal(omitted.status, 200);
    assert.deepEqual(requests[0], { action: "test", value: { url: "http://ha.local:8123" } });

    const empty = await fetch(`${url}/api/ha/test`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://ha.local:8123", token: "" })
    });
    assert.equal(empty.status, 200);
    assert.deepEqual(requests[1], { action: "test", value: { url: "http://ha.local:8123", token: "" } });

    const omittedEntities = await fetch(`${url}/api/ha/entities`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://ha.local:8123" })
    });
    assert.equal(omittedEntities.status, 200);
    assert.deepEqual(requests[2], { action: "entities", value: { url: "http://ha.local:8123" } });

    const emptyEntities = await fetch(`${url}/api/ha/entities`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://ha.local:8123", token: "" })
    });
    assert.equal(emptyEntities.status, 200);
    assert.deepEqual(requests[3], { action: "entities", value: { url: "http://ha.local:8123", token: "" } });
  } finally { await server.close(); }
});

test("serves bounded logs and emits named log snapshots without runtime events", { concurrency: false }, async () => {
  let entries = [{ timestamp: "2026-09-06T12:00:00.000Z", level: "info" as const, source: "test", message: "first" }];
  const listeners = new Set<() => void>();
  const status = () => ({ board: "note" as const, nextAttemptAt: 1, manualPause: false, haPause: false, paused: false, codex: {}, login: { pending: false } });
  const server = await startWebServer({
    status, config: () => ({ config: DEFAULT_APP_CONFIG, legacyEnvironmentVariables: [], hasSecrets: { token: false, localApiKey: false, haToken: false } }),
    elements: () => ({ elements: [], defaultLayout: [] }), save: async () => ({} as never), preview: () => ({ text: "", characters: [] }), pause: async () => status(), login: async () => ({ pending: false }),
    logs: () => ({ entries }),
    subscribeLogs: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
  }, { port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    assert.deepEqual(await (await fetch(`${url}/api/logs`)).json(), { entries });
    const response = await fetch(`${url}/api/events`);
    const reader = response.body!.getReader();
    let initial = "";
    while (!initial.includes("event: logs")) initial += new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /data:/);
    assert.match(initial, /event: logs/);
    entries = [{ ...entries[0]!, message: "second" }];
    for (const listener of listeners) listener();
    const update = new TextDecoder().decode((await reader.read()).value);
    assert.match(update, /event: logs/);
    assert.match(update, /second/);
    await reader.cancel();
  } finally { await server.close(); }
});
