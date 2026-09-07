import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PauseStore } from "../src/pause.js";

test("manual pause survives restart and combines requested state with persisted state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vbmux-v2-pause-"));
  try {
    const pause = await PauseStore.open(dir);
    await pause.setManual(true);
    assert.equal(pause.status().paused, true);
    const reopened = await PauseStore.open(dir);
    assert.equal(reopened.status().manualPause, true);
    await reopened.setManual(false);
    assert.equal(reopened.status().paused, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("queued pause writes retain each call's target instead of mutating an older write", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vbmux-v2-pause-race-"));
  try {
    const pause = await PauseStore.open(dir);
    const first = pause.setManual(true);
    const second = pause.setManual(false);
    const third = pause.setManual(true);
    assert.equal(pause.status().manualPause, true);
    await Promise.all([first, second, third]);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "pause.json"), "utf8")), { manualPause: true });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid pause storage fails closed and remains paused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vbmux-v2-pause-invalid-"));
  try {
    await writeFile(join(dir, "pause.json"), "not-json");
    const pause = await PauseStore.open(dir);
    assert.equal(pause.status().paused, true);
    assert.match(pause.status().persistenceError ?? "", /invalid/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
