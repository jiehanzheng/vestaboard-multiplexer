import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, type PublicConfig } from "../src/config.js";
import { createApplication } from "../src/application.js";

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
