import assert from "node:assert/strict";
import test from "node:test";
import { CollectionController } from "../src/runtime/collection.js";

test("collection starts immediately, waits between polls, and stops cleanly", async () => {
  let reads = 0;
  const waits: number[] = [];
  const collection = new CollectionController({
    intervalMs: 60_000,
    collect: async () => { reads += 1; },
    sleep: async (ms) => { waits.push(ms); },
    logger: { warn() {} }
  });

  const run = collection.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reads, 1);
  assert.deepEqual(waits, [60_000]);
  await collection.stop();
  await run;
  assert.equal(collection.status().running, false);
});

test("collection stop cancels its default polling timer", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => {
    let timer: ReturnType<typeof setTimeout>;
    timer = originalSetTimeout((...callbackArgs: any[]) => {
      timers.delete(timer);
      callback(...callbackArgs);
    }, delay, ...args);
    timers.add(timer);
    return timer;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    timers.delete(timer);
    originalClearTimeout(timer);
  }) as typeof clearTimeout;

  try {
    const collection = new CollectionController({ intervalMs: 60 * 60_000, collect: async () => {} });
    const run = collection.start();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(timers.size, 1);
    await collection.stop();
    await run;
    assert.equal(timers.size, 0);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
