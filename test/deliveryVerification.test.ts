import test from "node:test";
import assert from "node:assert/strict";
import { DeliveryController, type DeliveryTarget } from "../src/runtime/delivery.js";
import { intervalLimit } from "../src/contracts/updateLimits.js";
import { createVestaboardClient, type VestaboardMessage } from "../src/vestaboard.js";

const message = (code: number): VestaboardMessage => ({ text: String(code), characters: Array.from({ length: 3 }, () => Array(15).fill(code)) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture(minutes = 0.001) {
  let time = 0;
  let observed = message(0).characters!;
  const sent: number[] = [];
  const reads: number[] = [];
  const warnings: string[] = [];
  let read: DeliveryTarget["readCurrent"] = async () => { reads.push(time); return observed; };
  let send: DeliveryTarget["send"] = async (frame) => { sent.push(frame.characters![0]![0]!); };
  let target: DeliveryTarget = { send: (frame, paused) => send(frame, paused), readCurrent: () => read!(), observationSource: "local" };
  const delivery = new DeliveryController({ limits: intervalLimit(minutes), captureTarget: () => ({ ...target }), now: () => new Date(time), logger: { info() {}, warn(value) { warnings.push(String(value)); } } });
  return { delivery, sent, reads, warnings, time(value: number) { time = value; }, observe(code: number) { observed = message(code).characters!; },
    read(value: DeliveryTarget["readCurrent"]) { read = value; }, send(value: DeliveryTarget["send"]) { send = value; }, target(value: DeliveryTarget) { target = value; },
    async at(value: number) { time = value; return delivery.attempt(); } };
}

test("accepted is not observed; persistent mismatch gets exactly one budgeted corrective write", async () => {
  const f = fixture(10);
  f.delivery.updateFrame(message(1));
  assert.equal((await f.at(0)).outcome, "sent");
  assert.equal(f.delivery.status().verification?.state, "pending");
  await f.at(60_000); await f.at(120_000);
  assert.equal(f.delivery.status().verification?.state, "mismatch");
  assert.equal((await f.at(120_000)).outcome, "limited");
  assert.equal((await f.delivery.attemptManual()).outcome, "limited", "recovery cannot use save bypass");
  await f.at(600_000);
  assert.deepEqual(f.sent, [1, 1]);
  assert.equal(f.delivery.status().limits[0]!.used, 1);
  await f.at(660_000); await f.at(720_000); await f.at(1_800_000);
  assert.deepEqual(f.sent, [1, 1]);
  assert.equal(f.delivery.status().verification?.state, "mismatch");
  assert.equal(f.delivery.status().pending, false);
  assert.match(f.delivery.status().verification!.error!, /stopped/);
});

test("transient mismatch then matching readback needs no correction or continuous enforcement", async () => {
  const f = fixture(); f.delivery.updateFrame(message(1)); await f.at(0);
  await f.at(60_000); f.observe(1); await f.at(120_000);
  assert.equal(f.delivery.status().verification?.state, "matched");
  f.observe(2); await f.at(180_000);
  assert.equal(f.reads.length, 2, "verification ends after match; external messages are not reclaimed later");
  assert.deepEqual(f.sent, [1]);
});

test("read failure is unverified and cannot authorize a blind corrective write", async () => {
  const f = fixture(); f.delivery.updateFrame(message(1)); await f.at(0);
  f.read(async () => { throw new Error("403 private-token"); });
  await f.at(60_000); await f.at(120_000);
  assert.equal(f.delivery.status().verification?.state, "unverified");
  assert.doesNotMatch(JSON.stringify(f.delivery.status()), /private-token/);
  assert.deepEqual(f.sent, [1]);
});

test("changing content and repeated composition cannot refill an unresolved correction budget", async () => {
  const f = fixture(); f.delivery.updateFrame(message(1)); await f.at(0);
  await f.at(60_000); await f.at(120_000); await f.at(120_001);
  f.delivery.updateFrame(message(2)); await f.at(120_100);
  for (let i = 0; i < 5; i++) f.delivery.updateFrame(message(2));
  await f.at(180_100); await f.at(240_100); await f.at(300_100);
  assert.deepEqual(f.sent, [1, 1, 2]);
  assert.equal(f.delivery.status().verification?.state, "mismatch");
  // A later confirmed delivery ends the episode and restores the one-correction allowance.
  f.observe(3); f.delivery.updateFrame(message(3)); await f.at(300_101); await f.at(360_101);
  assert.equal(f.delivery.status().verification?.correctionUsed, false);
});

test("a failed correction of a newer coalesced intent stops, without claiming it was accepted", async () => {
  const f = fixture(); f.delivery.updateFrame(message(1)); await f.at(0);
  await f.at(60_000); await f.at(120_000);
  f.delivery.updateFrame(message(2));
  f.send(async () => { throw new Error("unreachable"); });
  assert.equal((await f.at(120_100)).outcome, "failed");
  assert.deepEqual(f.delivery.lastSent(), message(1));
  assert.equal(f.delivery.status().verification?.state, "unverified");
  assert.equal((await f.at(300_000)).outcome, "unchanged");
  assert.equal(f.delivery.status().pending, false);
});

test("readback remains attached to its accepted submission while newer intent stays pending", async () => {
  const f = fixture(); f.delivery.updateFrame(message(1)); await f.at(0);
  const gate = deferred<number[][]>(); f.read(() => gate.promise);
  f.time(60_000); const reading = f.delivery.attempt();
  f.delivery.updateFrame(message(2)); f.delivery.updateFrame(message(3));
  const concurrent = f.delivery.attempt();
  gate.resolve(message(1).characters!); await Promise.all([reading, concurrent]);
  assert.equal(f.delivery.status().verification?.state, "matched");
  assert.equal(f.delivery.status().pending, true, "matching old submission cannot confirm the newer desired frame");
  assert.deepEqual(f.delivery.lastSent(), message(1));
  await f.at(60_001); assert.deepEqual(f.sent, [1, 3]);
  assert.equal(f.delivery.status().verification?.state, "pending");
});

test("target reset fences in-flight observation and queued manual writes", async () => {
  const f = fixture(); f.delivery.updateFrame(message(1)); await f.at(0);
  const gate = deferred<number[][]>(); f.read(() => gate.promise);
  f.time(60_000); const reading = f.delivery.attempt();
  const manual = f.delivery.attemptManual(); const reset = f.delivery.resetTarget();
  gate.resolve(message(1).characters!); await Promise.all([reading, manual, reset]);
  assert.equal(f.delivery.lastSent(), undefined);
  assert.equal(f.delivery.status().verification, undefined);
  assert.deepEqual(f.sent, [1]);
  f.target({ send: async () => { f.sent.push(9); }, readCurrent: async () => message(9).characters!, observationSource: "cloud" });
  f.delivery.updateFrame(message(9)); await f.at(60_001); await f.at(120_001);
  assert.equal(f.delivery.status().verification?.source, "cloud");
  assert.equal(f.delivery.status().verification?.state, "matched");
});

test("stop fences late observations and system pause never authorizes recovery", async () => {
  const f = fixture(); f.delivery.updateFrame(message(1)); await f.at(0);
  const gate = deferred<number[][]>(); f.read(() => gate.promise);
  f.time(60_000); const reading = f.delivery.attempt();
  f.delivery.pause("configuration"); gate.resolve(message(1).characters!); await reading;
  assert.notEqual(f.delivery.status().verification?.state, "matched");
  assert.equal((await f.at(120_000)).outcome, "paused");
  f.delivery.resume(); const again = deferred<number[][]>(); f.read(() => again.promise);
  const reread = f.delivery.attempt(); const stop = f.delivery.stop();
  again.resolve(message(1).characters!); await Promise.all([reread, stop]);
  assert.equal(f.delivery.status().running, false);
  assert.notEqual(f.delivery.status().verification?.state, "matched");
});

test("synchronous status callbacks cannot reenter a write before operation ownership is installed", async () => {
  const f = fixture(); let calls = 0;
  f.delivery.onStatusChange(() => { calls++; void f.delivery.attempt(); });
  f.delivery.updateFrame(message(1)); await f.delivery.attempt();
  assert.deepEqual(f.sent, [1]); assert.equal(calls, 1);
});

test("pause and resume use only latest frames while observation is in flight", async () => {
  const f = fixture(); const flags: boolean[] = [];
  f.send(async (frame, paused) => { f.sent.push(frame.characters![0]![0]!); flags.push(!!paused); });
  f.delivery.updateFrame(message(1), false); await f.at(0);
  const gate = deferred<number[][]>(); f.read(() => gate.promise);
  f.time(60_000); const read = f.delivery.attempt();
  f.delivery.updateFrame(message(2), true); f.delivery.updateFrame(message(3), false);
  gate.resolve(message(1).characters!); await read; await f.delivery.attempt();
  assert.deepEqual(f.sent, [1, 3]); assert.deepEqual(flags, [false, false]);
});

test("cloud transport spacing applies to failures, settings-save bypass and startup", async () => {
  const f = fixture(); let attempts = 0;
  f.target({ send: async () => { attempts++; if (attempts === 1) throw new Error("offline"); }, minimumWriteIntervalMs: 15_000 });
  f.delivery.updateFrame(message(1)); await f.at(0);
  f.time(1); assert.equal((await f.delivery.attemptManual()).outcome, "limited");
  assert.equal((await f.delivery.deliverStartup(message(2), 30_000)).outcome, "limited");
  await f.at(15_000); assert.equal(attempts, 2);
});

test("observation honors scheduled animation steps without claiming mechanical completion", async () => {
  const f = fixture(); f.target({ send: async () => {}, readCurrent: async () => message(1).characters!, observationDelayMs: () => 180_000 });
  f.delivery.updateFrame(message(1)); await f.at(0); await f.at(60_000);
  assert.equal(f.delivery.status().verification?.state, "pending");
  await f.at(180_000); assert.equal(f.delivery.status().verification?.state, "matched");
});

for (const source of ["local", "cloud"] as const) {
  test(`${source} readback normalizes and validates matrices and uses the configured endpoint`, async () => {
    const matrix = message(1).characters!; const requests: RequestInit[] = [];
    const client = createVestaboardClient({ dryRun: false, ...(source === "local" ? { localApiKey: "key" } : { token: "key" }), fetchImpl: async (_url, init) => {
      requests.push(init!); return Response.json(source === "local" ? { message: matrix } : { currentMessage: { layout: JSON.stringify(matrix) } });
    } });
    assert.deepEqual(await client.readCurrent!(), matrix); assert.equal(requests[0]!.method, "GET");
    assert.equal(client.observationSource, source);
    for (const body of [{}, { message: [[71]] }, { currentMessage: { layout: "bad" } }]) {
      const broken = createVestaboardClient({ dryRun: false, ...(source === "local" ? { localApiKey: "key" } : { token: "key" }), fetchImpl: async () => Response.json(body) });
      await assert.rejects(broken.readCurrent!());
    }
  });
}

test("cloud validates documented acknowledgement; local does not invent a response schema", async () => {
  const cloud = createVestaboardClient({ dryRun: false, token: "key", fetchImpl: async () => Response.json({ status: "error", message: "private" }) });
  await assert.rejects(cloud.send(message(1)), /did not acknowledge/);
  const muted = createVestaboardClient({ dryRun: false, token: "key", fetchImpl: async () => Response.json({ status: "error" }, { status: 423 }) });
  await assert.rejects(muted.send(message(1)), /423/);
  const local = createVestaboardClient({ dryRun: false, localApiKey: "key", fetchImpl: async () => new Response("accepted") });
  await local.send(message(1));
  const dry = createVestaboardClient({ dryRun: true, localApiKey: "key", logger: { info() {} } });
  assert.equal(dry.readCurrent, undefined);
});

test("the owned scheduler wakes for verification, admits one correction, then stops polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(); f.delivery.updateFrame(message(1));
  const scheduler = f.delivery.startScheduler();
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  try {
    await settle(); assert.deepEqual(f.sent, [1]);
    for (const time of [60_000, 120_000, 180_000, 240_000, 300_000]) {
      f.time(time); t.mock.timers.tick(60_000); await settle(); t.mock.timers.tick(0); await settle();
    }
    assert.deepEqual(f.sent, [1, 1]); assert.equal(f.reads.length, 4);
    assert.equal(f.delivery.status().verification?.state, "mismatch");
    f.time(3_000_000); t.mock.timers.tick(2_700_000); await settle();
    assert.equal(f.reads.length, 4); assert.equal(f.sent.length, 2);
  } finally { await f.delivery.stop(); await scheduler; }
});

test("target reset during a write cannot publish stale acceptance or erase a newly queued intent", async () => {
  const f = fixture(); const gate = deferred<void>(); f.send(() => gate.promise);
  f.delivery.updateFrame(message(1)); const writing = f.delivery.attempt();
  const reset = f.delivery.resetTarget();
  f.delivery.updateFrame(message(2), true);
  gate.resolve(); await Promise.all([writing, reset]);
  assert.equal(f.delivery.lastSent(), undefined);
  const flags: boolean[] = [];
  f.target({ send: async (_frame, paused) => { flags.push(!!paused); } });
  await f.at(60); assert.deepEqual(f.delivery.lastSent(), message(2));
  assert.deepEqual(flags, [true]);
});

test("readback failure and malformed cloud acknowledgement never force quiet hours or expose response data", async () => {
  for (const body of ["", "not-json", JSON.stringify({ status: "error", message: "secret" })]) {
    const client = createVestaboardClient({ dryRun: false, token: "key", fetchImpl: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).forced, undefined);
      return new Response(body);
    } });
    await assert.rejects(client.send(message(1)), /did not acknowledge/);
  }
});

test("corrective pause/resume writes retain the transition of their unconfirmed submission", async () => {
  const f = fixture(); const flags: boolean[] = [];
  f.send(async (_frame, paused) => { flags.push(!!paused); });
  f.delivery.updateFrame(message(1), true); await f.at(0);
  await f.at(60_000); await f.at(120_000); await f.at(120_001);
  assert.deepEqual(flags, [true, true]);
});

test("an explicit save of new content retains its admission exception during unresolved verification", async () => {
  const f = fixture(10); f.delivery.updateFrame(message(1)); await f.at(0);
  await f.at(60_000); await f.at(120_000);
  assert.equal((await f.delivery.attemptManual()).outcome, "limited", "same-frame correction stays budgeted");
  f.delivery.updateFrame(message(2));
  assert.equal((await f.delivery.attemptManual()).outcome, "sent", "new explicit intent keeps Save's exception");
  assert.equal(f.delivery.status().limits[0]!.used, 2);
  assert.equal(f.delivery.status().verification?.correctionUsed, false);
});

test("an unaccepted correction cannot advance the accepted pause state", async () => {
  const f = fixture(); const flags: boolean[] = [];
  f.send(async (_frame, paused) => { flags.push(!!paused); });
  f.delivery.updateFrame(message(1), true); await f.at(0);
  await f.at(60_000); await f.at(120_000);
  f.delivery.updateFrame(message(2), false);
  f.send(async () => { throw new Error("offline"); }); await f.at(120_100); await f.at(180_100);
  f.send(async (_frame, paused) => { flags.push(!!paused); });
  f.delivery.updateFrame(message(3), false); await f.at(180_200);
  assert.deepEqual(flags, [true, true], "later resume still transitions from last accepted pause state");
});

test("continuous new intent cannot starve due readback of the last accepted submission", async () => {
  const f = fixture(); f.delivery.updateFrame(message(1)); await f.at(0);
  f.observe(1); f.delivery.updateFrame(message(2));
  await f.at(60_000);
  assert.equal(f.reads.length, 1); assert.deepEqual(f.sent, [1]);
  assert.equal(f.delivery.status().pending, true);
  await f.at(60_001); assert.deepEqual(f.sent, [1, 2]);
});

test("due readback cannot consume the one immediate delivery attempt of an explicit save", async () => {
  const f = fixture(10); f.delivery.updateFrame(message(1)); await f.at(0);
  f.time(60_000); f.delivery.updateFrame(message(2));
  assert.equal((await f.delivery.attemptManual()).outcome, "sent");
  assert.deepEqual(f.sent, [1, 2]); assert.equal(f.reads.length, 0);
});
