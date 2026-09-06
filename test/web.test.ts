import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PauseStore } from "../src/pause.js";
import { startWebServer } from "../src/webServer.js";

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

test("HTTP actions validate JSON/origin and SSE reconnect receives current snapshot", async () => {
  let value = 1;
  const server = await startWebServer({
    status: () => ({ value }), config: () => ({}), elements: () => [],
    save: async () => ({}), preview: () => ({}), pause: async () => ({}), login: async () => ({})
  }, { port: Number(process.env.VBMUX_TEST_PORT ?? 0), host: "127.0.0.1" });
  const url = `http://127.0.0.1:${server.port}`;
  try {
    assert.equal((await fetch(`${url}/api/config`, { method: "POST", headers: { "content-type": "application/json", origin: "http://elsewhere" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${url}/api/config`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status, 400);
    for (const expected of [1, 2]) {
      value = expected;
      const abort = new AbortController();
      const response = await fetch(`${url}/api/events`, { signal: abort.signal });
      const reader = response.body!.getReader();
      const chunk = await reader.read();
      assert.match(new TextDecoder().decode(chunk.value), new RegExp(`"value":${expected}`));
      abort.abort();
      await reader.cancel().catch(() => {});
    }
  } finally { await server.close(); }
});
