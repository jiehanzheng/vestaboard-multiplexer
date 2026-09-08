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

test("delivery lengthens a pending deadline from the last normal attempt", async () => {
  let nowMs = 0;
  let sends = 0;
  const delivery = new DeliveryController({
    intervalMs: 5 * 60_000,
    now: () => new Date(nowMs),
    send: async () => { sends += 1; },
    logger: { info() {}, warn() {} }
  });
  delivery.updateFrame(message("first"));
  assert.equal((await delivery.attempt()).outcome, "sent");
  delivery.setInterval(30 * 60_000);
  delivery.updateFrame(message("second"));
  nowMs = 5 * 60_000;
  assert.equal((await delivery.attempt()).outcome, "limited");
  nowMs = 30 * 60_000;
  assert.equal((await delivery.attempt()).outcome, "sent");
  assert.equal(sends, 2);
});

test("delivery shortens a pending deadline from the last normal attempt", async () => {
  let nowMs = 0;
  let sends = 0;
  const delivery = new DeliveryController({
    intervalMs: 30 * 60_000,
    now: () => new Date(nowMs),
    send: async () => { sends += 1; },
    logger: { info() {}, warn() {} }
  });
  delivery.updateFrame(message("first"));
  assert.equal((await delivery.attempt()).outcome, "sent");
  delivery.setInterval(5 * 60_000);
  delivery.updateFrame(message("second"));
  nowMs = 5 * 60_000;
  assert.equal((await delivery.attempt()).outcome, "sent");
  assert.equal(sends, 2);
});

test("unchanged frames skip a write without blocking the next changed frame", async () => {
  let nowMs = 0;
  let sends = 0;
  let shouldFail = false;
  const infos: unknown[] = [];
  const warnings: unknown[] = [];
  const delivery = new DeliveryController({
    intervalMs: 60_000,
    now: () => new Date(nowMs),
    send: async () => { sends += 1; if (shouldFail) throw new Error("board unavailable"); },
    logger: { info: (message) => infos.push(message), warn: (message) => warnings.push(message) }
  });
  delivery.updateFrame(message("same"));
  assert.equal((await delivery.attempt()).outcome, "sent");
  nowMs = 60_000;
  assert.equal((await delivery.attempt()).outcome, "unchanged");
  assert.deepEqual(infos, ["Sent latest Vestaboard frame."]);
  assert.equal(sends, 1);
  delivery.updateFrame(message("changed"));
  assert.equal((await delivery.attempt()).outcome, "sent");
  assert.equal(infos.length, 2);
  assert.equal(sends, 2);
  shouldFail = true;
  nowMs = 120_000;
  delivery.updateFrame(message("failure"));
  assert.equal((await delivery.attempt()).outcome, "failed");
  assert.equal(warnings.length, 1);
});

test("pause animation follows the physical pause state and coalesces toggles", async () => {
  let nowMs = 0;
  let shouldFail = false;
  const animationFlags: boolean[] = [];
  const delivery = new DeliveryController({
    intervalMs: 60_000,
    now: () => new Date(nowMs),
    send: async (_frame, usePauseAnimation) => {
      animationFlags.push(Boolean(usePauseAnimation));
      if (shouldFail) throw new Error("board unavailable");
    },
    logger: { info() {}, warn() {} }
  });

  delivery.updateFrame(message("normal"), false);
  assert.equal((await delivery.attempt()).outcome, "sent");
  nowMs = 60_000;
  delivery.updateFrame(message("paused"), true);
  assert.equal((await delivery.attempt()).outcome, "sent");
  nowMs = 120_000;
  delivery.updateFrame(message("resumed"), false);
  assert.equal((await delivery.attempt()).outcome, "sent");
  assert.deepEqual(animationFlags, [false, true, true]);

  nowMs = 180_000;
  shouldFail = true;
  delivery.updateFrame(message("failed-pause"), true);
  assert.equal((await delivery.attempt()).outcome, "failed");
  nowMs = 240_000;
  shouldFail = false;
  assert.equal((await delivery.attempt()).outcome, "sent");
  assert.deepEqual(animationFlags, [false, true, true, true, true]);

  nowMs = 300_000;
  delivery.updateFrame(message("routine-paused-update"), true);
  assert.equal((await delivery.attempt()).outcome, "sent");
  assert.equal(animationFlags.at(-1), false);

  const coalescedFlags: boolean[] = [];
  const coalesced = new DeliveryController({
    intervalMs: 60_000,
    send: async (_frame, usePauseAnimation) => { coalescedFlags.push(Boolean(usePauseAnimation)); },
    logger: { info() {}, warn() {} }
  });
  coalesced.updateFrame(message("coalesced-normal"), false);
  assert.equal((await coalesced.attempt()).outcome, "sent");
  coalesced.updateFrame(message("coalesced-pause"), true);
  coalesced.updateFrame(message("coalesced-resume"), false);
  assert.equal((await coalesced.attemptManual()).outcome, "sent");
  assert.deepEqual(coalescedFlags, [false, false]);
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
  assert.equal(delivery.status().nextAttemptAt, undefined);
  assert.equal((await delivery.attempt()).outcome, "sent");
  assert.equal(sends, 3);
});

test("manual delivery bypasses the normal interval once and starts a new interval", async () => {
  let nowMs = 0;
  let sends = 0;
  const delivery = new DeliveryController({
    intervalMs: 300_000,
    now: () => new Date(nowMs),
    send: async () => { sends += 1; },
    logger: { info() {}, warn() {} }
  });

  delivery.updateFrame(message("first"));
  assert.equal((await delivery.attempt()).outcome, "sent");
  nowMs = 1_000;
  delivery.updateFrame(message("saved"));
  assert.equal((await delivery.attemptManual()).outcome, "sent");
  nowMs = 300_999;
  delivery.updateFrame(message("automatic"));
  assert.equal((await delivery.attempt()).outcome, "limited");
  nowMs = 301_000;
  assert.equal((await delivery.attempt()).outcome, "sent");
  assert.equal(sends, 3);
});

test("manual failure consumes the normal interval", async () => {
  let nowMs = 0;
  let sends = 0;
  let shouldFail = true;
  const delivery = new DeliveryController({
    intervalMs: 60_000,
    now: () => new Date(nowMs),
    send: async () => {
      sends += 1;
      if (shouldFail) throw new Error("manual unavailable");
    },
    logger: { info() {}, warn() {} }
  });

  delivery.updateFrame(message("saved"));
  assert.equal((await delivery.attemptManual()).outcome, "failed");
  nowMs = 59_999;
  shouldFail = false;
  delivery.updateFrame(message("automatic"));
  assert.equal((await delivery.attempt()).outcome, "limited");
  nowMs = 60_000;
  assert.equal((await delivery.attempt()).outcome, "sent");
  assert.equal(sends, 2);
});

test("manual delivery skips unchanged and paused frames without writing", async () => {
  let sends = 0;
  const delivery = new DeliveryController({
    intervalMs: 60_000,
    send: async () => { sends += 1; },
    logger: { info() {}, warn() {} }
  });

  delivery.updateFrame(message("same"));
  assert.equal((await delivery.attempt()).outcome, "sent");
  assert.equal((await delivery.attemptManual()).outcome, "unchanged");
  delivery.updateFrame(message("paused"));
  delivery.pause("operator");
  assert.equal((await delivery.attemptManual()).outcome, "paused");
  assert.equal(sends, 1);
});

test("manual delivery waits for an in-flight write and sends the latest frame", async () => {
  let release!: () => void;
  const started = new Promise<void>((resolve) => { release = resolve; });
  const sent: string[] = [];
  const delivery = new DeliveryController({
    intervalMs: 60_000,
    send: async (frame) => {
      sent.push(frame.text);
      if (frame.text === "old") await started;
    },
    logger: { info() {}, warn() {} }
  });

  delivery.updateFrame(message("old"));
  const first = delivery.attempt();
  await Promise.resolve();
  delivery.updateFrame(message("latest"));
  const manual = delivery.attemptManual();
  await Promise.resolve();
  assert.deepEqual(sent, ["old"]);
  release();
  assert.equal((await first).outcome, "sent");
  assert.equal((await manual).outcome, "sent");
  assert.deepEqual(sent, ["old", "latest"]);
});

test("manual delivery respects the startup hold", async () => {
  let nowMs = 0;
  let sends = 0;
  const delivery = new DeliveryController({
    intervalMs: 300_000,
    now: () => new Date(nowMs),
    send: async () => { sends += 1; },
    logger: { info() {}, warn() {} }
  });

  assert.equal((await delivery.deliverStartup(message("banner"), 30_000)).outcome, "sent");
  delivery.updateFrame(message("saved"));
  nowMs = 29_999;
  assert.equal((await delivery.attemptManual()).outcome, "limited");
  nowMs = 30_000;
  assert.equal((await delivery.attemptManual()).outcome, "sent");
  assert.equal(sends, 2);
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

test("a target transition waits for an old write and invalidates its cache", async () => {
  let release!: () => void;
  const writeStarted = new Promise<void>((resolve) => { release = resolve; });
  const delivery = new DeliveryController({
    intervalMs: 60_000,
    send: async () => writeStarted,
    logger: { info() {}, warn() {} }
  });
  delivery.updateFrame(message("old-target"));
  const attempt = delivery.attempt();
  await Promise.resolve();
  const transition = delivery.resetTarget();
  let transitioned = false;
  void transition.then(() => { transitioned = true; });
  await Promise.resolve();
  assert.equal(transitioned, false);
  release();
  await transition;
  await attempt;
  assert.equal(delivery.lastSent(), undefined);
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
