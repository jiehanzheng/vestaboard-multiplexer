import assert from "node:assert/strict";
import test from "node:test";
import { CollectionController } from "../src/runtime/collection.js";
import { DeliveryController } from "../src/runtime/delivery.js";

function message(text: string) {
  return { text };
}

test("delivery attempts are separated by the configured interval and failures consume the slot", async () => {
  let nowMs = 0;
  let sends = 0;
  let shouldFail = true;
  const delivery = new DeliveryController({
    intervalMs: 300_000,
    now: () => new Date(nowMs),
    send: async () => {
      sends += 1;
      if (shouldFail) throw new Error("temporary");
    },
    logger: { info() {}, warn() {} }
  });
  delivery.updateFrame(message("quota"));

  assert.equal((await delivery.attempt()).outcome, "failed");
  nowMs = 299_999;
  assert.equal((await delivery.attempt()).outcome, "limited");
  nowMs = 300_000;
  shouldFail = false;
  assert.equal((await delivery.attempt()).outcome, "sent");
  assert.equal(sends, 2);
});

test("unchanged frames skip a write without blocking the next changed frame", async () => {
  let nowMs = 0;
  let sends = 0;
  const delivery = new DeliveryController({
    intervalMs: 60_000,
    now: () => new Date(nowMs),
    send: async () => { sends += 1; },
    logger: { info() {}, warn() {} }
  });
  delivery.updateFrame(message("same"));
  assert.equal((await delivery.attempt()).outcome, "sent");
  nowMs = 60_000;
  assert.equal((await delivery.attempt()).outcome, "unchanged");
  assert.equal(sends, 1);
  delivery.updateFrame(message("changed"));
  assert.equal((await delivery.attempt()).outcome, "sent");
  assert.equal(sends, 2);
});

test("startup bypasses the normal limiter and holds the next attempt only after success", async () => {
  let nowMs = 0;
  let sends = 0;
  let shouldFail = true;
  const delivery = new DeliveryController({
    intervalMs: 300_000,
    now: () => new Date(nowMs),
    send: async () => {
      sends += 1;
      if (shouldFail) throw new Error("startup unavailable");
    },
    logger: { info() {}, warn() {} }
  });

  assert.equal((await delivery.deliverStartup(message("banner"), 30_000)).outcome, "failed");
  assert.equal(delivery.status().nextAttemptAt, undefined);
  shouldFail = false;
  assert.equal((await delivery.deliverStartup(message("banner"), 30_000)).outcome, "sent");
  assert.equal(delivery.status().nextAttemptAt?.getTime(), 30_000);
  nowMs = 29_999;
  delivery.updateFrame(message("quota"));
  assert.equal((await delivery.attempt()).outcome, "limited");
  nowMs = 30_000;
  assert.equal((await delivery.attempt()).outcome, "sent");
  assert.equal(sends, 3);
});

test("paused delivery exposes status and resumes with the latest frame", async () => {
  let nowMs = 0;
  const sent: string[] = [];
  const delivery = new DeliveryController({
    intervalMs: 60_000,
    now: () => new Date(nowMs),
    send: async (frame) => { sent.push(frame.text); },
    logger: { info() {}, warn() {} }
  });
  delivery.updateFrame(message("first"));
  delivery.pause("demo");
  assert.equal((await delivery.attempt()).outcome, "paused");
  assert.equal(delivery.status().pauseReason, "demo");
  delivery.updateFrame(message("latest"));
  delivery.resume();
  assert.equal((await delivery.attempt()).outcome, "sent");
  assert.deepEqual(sent, ["latest"]);
});

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
    const collection = new CollectionController({
      intervalMs: 60 * 60_000,
      collect: async () => {}
    });
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
