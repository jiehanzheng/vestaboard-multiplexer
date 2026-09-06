import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PauseStore } from "../src/pause.js";

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
