import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore, type PublicConfig } from "../src/config.js";
import { createApplication } from "../src/application.js";
import { createCodexIntegration } from "../src/plugins/codexQuota/integration.js";
import type { VestaboardMessage } from "../src/vestaboard.js";

test("auto-detected board changes reject layouts before persisting the new target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-target-layout-"));
  const store = await ConfigStore.open(directory, {});
  await store.save({ ...store.get(), board: "flagship", codex: { ...store.get().codex, enabled: false }, layout: [{ elementId: "codex.status", startRow: 5 }] });
  const app = await createApplication(store, directory, true, {
    createVestaboardClient: () => ({ send: async () => {}, detectBoard: async () => "note" as const })
  });
  try {
    await app.start();
    const before = store.get();
    await assert.rejects(app.actions.save({ board: "auto" }), /out of bounds/);
    assert.deepEqual(store.get(), before);
    assert.equal(app.actions.status().board, "flagship");
    assert.equal(app.actions.status().configError, undefined);
  } finally { await app.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("auto board detection retries before delivering a frame with assumed dimensions", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-board-retry-"));
  const sent: VestaboardMessage[] = [];
  let detections = 0;
  let tick!: () => void;
  let resolveComposition!: () => void;
  const compositionSent = new Promise<void>((resolve) => { resolveComposition = resolve; });
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_TOKEN: "board-token" });
  const app = await createApplication(store, directory, true, {
    setInterval: ((callback: () => void) => {
      tick = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: () => {},
    createVestaboardClient: () => ({
      detectBoard: async () => {
        detections += 1;
        return detections === 1 ? undefined : "flagship";
      },
      send: async (frame: VestaboardMessage) => {
        sent.push(frame);
        if (frame.characters) resolveComposition();
      }
    })
  });
  const confirmed = new Promise<void>((resolve) => {
    app.onChange(() => {
      if (app.actions.status().board === "flagship") resolve();
    });
  });
  try {
    await app.start();
    tick();
    await Promise.all([confirmed, compositionSent]);
    assert.equal(detections, 2);
    const composed = sent.filter((frame) => frame.characters);
    assert.ok(composed.length > 0);
    assert.ok(composed.every((frame) => frame.characters?.length === 6 && frame.characters.every((row) => row.length === 22)));
  } finally { await app.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("same-size auto detection confirmation resumes the paused composition", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-board-confirmation-"));
  const sent: VestaboardMessage[] = [];
  let detections = 0;
  let tick!: () => void;
  let resolveComposition!: () => void;
  const compositionSent = new Promise<void>((resolve) => { resolveComposition = resolve; });
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_TOKEN: "board-token" });
  const app = await createApplication(store, directory, true, {
    setInterval: ((callback: () => void) => {
      tick = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: () => {},
    createVestaboardClient: () => ({
      detectBoard: async () => {
        detections += 1;
        return detections === 1 ? undefined : "note";
      },
      send: async (frame: VestaboardMessage) => {
        sent.push(frame);
        if (frame.characters) resolveComposition();
      }
    })
  });
  try {
    await app.start();
    tick();
    await compositionSent;
    assert.equal(detections, 2);
    const composed = sent.filter((frame) => frame.characters);
    assert.ok(composed.length > 0);
    assert.ok(composed.every((frame) => frame.characters?.length === 3 && frame.characters.every((row) => row.length === 15)));
    assert.equal(app.actions.status().paused, false);
  } finally { await app.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("board detection retry waits behind a target save and cannot replace its resolver", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-board-save-race-"));
  let detections = 0;
  let tick!: () => void;
  let resolveCandidate!: (board: "note" | "flagship") => void;
  let candidateStarted!: () => void;
  const candidateReady = new Promise<void>((resolve) => { candidateStarted = resolve; });
  const candidateBoard = new Promise<"note" | "flagship">((resolve) => { resolveCandidate = resolve; });
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_BOARD: "auto", VESTABOARD_TOKEN: "board-token" });
  const app = await createApplication(store, directory, true, {
    setInterval: ((callback: () => void) => {
      tick = callback;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: () => {},
    createVestaboardClient: () => ({
      detectBoard: async () => {
        detections += 1;
        if (detections === 1) return undefined;
        if (detections === 2) {
          candidateStarted();
          return candidateBoard;
        }
        return "note";
      },
      send: async () => {}
    })
  });
  try {
    await app.start();
    const next = store.get();
    next.transport.token = "new-board-token";
    const saving = app.actions.save(next);
    await candidateReady;
    tick();
    resolveCandidate("flagship");
    await saving;
    assert.equal(detections, 2, "the queued retry must not call the old resolver after the save replaces it");
    assert.equal(app.actions.status().board, "flagship");
    assert.equal(app.actions.status().paused, false, "a confirmed saved target must not inherit the old retry pause");
  } finally { await app.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("server and one-shot share frames, and status/preview cannot collect or deliver", { timeout: 5_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-parity-"));
  const now = () => new Date("2026-09-06T12:00:00Z");
  let reads = 0;
  let collected!: () => void;
  const firstRead = new Promise<void>((resolve) => { collected = resolve; });
  const sent: VestaboardMessage[] = [];
  const dependencies = {
    now,
    createVestaboardClient: () => ({ send: async (frame: VestaboardMessage) => { sent.push(frame); } }),
    createCodexIntegration: (config: Parameters<typeof createCodexIntegration>[0], options: Parameters<typeof createCodexIntegration>[1]) => createCodexIntegration(config, {
      ...options,
      readQuota: async () => {
        reads++;
        return { snapshot: { windows: [{ id: "primary", remainingRatio: 0.5, durationMins: 300, resetAt: new Date("2026-09-06T15:00:00Z") }] } };
      }
    })
  };
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_BOARD: "note" });
  const server = await createApplication(store, directory, true, dependencies);
  server.onChange(() => { if (server.actions.status().codex.collectedAt) collected(); });
  try {
    await server.start();
    await firstRead;
    assert.equal(server.actions.status().dryRun, true);
    const desired = server.actions.status().desired;
    const before = { reads, writes: sent.length };
    const layout = server.actions.elements().defaultLayout!;
    for (let i = 0; i < 3; i++) {
      server.actions.status(); server.actions.elements();
      assert.deepEqual(await server.actions.preview({ layout, board: "note" }), desired);
    }
    assert.deepEqual({ reads, writes: sent.length }, before);
    await server.stop();
    const once = await createApplication(store, directory, true, dependencies);
    try {
      const previousWrites = sent.length;
      await once.runOnce();
      assert.equal(sent.length, previousWrites + 1, "one-shot must not send a startup banner");
      assert.deepEqual(sent.at(-1), desired);
    } finally { await once.stop(); }
  } finally { await server.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("successful settings saves make one immediate delivery without leaving a bypass pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-manual-save-"));
  let nowMs = 0;
  let failSends = false;
  const sent: VestaboardMessage[] = [];
  const store = await ConfigStore.open(directory, {
    CODEX_QUOTA_SOURCE: "fixture",
    VESTABOARD_BOARD: "note",
    ORCHESTRATOR_INTERVAL_MINUTES: "5"
  });
  const app = await createApplication(store, directory, true, {
    now: () => new Date(nowMs),
    createVestaboardClient: () => ({
      send: async (frame: VestaboardMessage) => {
        sent.push(frame);
        if (failSends) throw new Error("board unavailable");
      }
    })
  });
  try {
    await app.runOnce();
    const initialWrites = sent.length;
    const initial = store.get();
    nowMs = 1_000;

    const changedResponse = await app.actions.save({ ...initial, layout: [] });
    assert.equal(sent.length, initialWrites + 1, "changed saved settings should send immediately");
    assert.equal(changedResponse.delivery, "sent");

    const afterChangedSave = store.get();
    const unchangedResponse = await app.actions.save({ ...afterChangedSave });
    assert.equal(sent.length, initialWrites + 1, "an unchanged saved frame should not write");
    assert.equal(unchangedResponse.delivery, "unchanged");

    const beforeFailedSave = sent.length;
    await assert.rejects(app.actions.save({ ...afterChangedSave, layout: [{ elementId: "codex.status", startRow: 5 }] }), /out of bounds/);
    assert.equal(sent.length, beforeFailedSave, "an invalid save should not trigger a delivery");

    await app.actions.pause({ paused: true });
    await app.actions.save({ ...afterChangedSave, layout: [{ elementId: "codex.status", startRow: 0 }] });
    assert.equal(sent.length, beforeFailedSave, "a paused save should not write");
    assert.equal((await app.actions.save({ ...afterChangedSave, layout: [] })).delivery, "paused");
    assert.equal(sent.length, beforeFailedSave, "a second paused save should not write");
    await app.actions.pause({ paused: false });
    assert.equal(sent.length, beforeFailedSave, "resuming should not release a saved bypass later");

    failSends = true;
    const beforeBoardFailure = sent.length;
    const failedBoardSave = { ...afterChangedSave, layout: [{ elementId: "codex.status", startRow: 1 }] };
    const failedBoardResponse = await app.actions.save(failedBoardSave);
    assert.equal(sent.length, beforeBoardFailure + 1, "a board failure still consumes one manual attempt");
    assert.equal(failedBoardResponse.delivery, "failed");
    assert.deepEqual((app.actions.config() as PublicConfig).config.layout, failedBoardSave.layout);
    assert.equal(app.actions.status().configError, undefined, "a board failure must not report a settings save failure");
    assert.match(app.actions.status().deliveryError ?? "", /Board update failed/);
  } finally {
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid environment configuration is visible and blocks delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-env-error-"));
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", ORCHESTRATOR_INTERVAL_MINUTES: "bad" });
  let writes = 0;
  const app = await createApplication(store, directory, true, { createVestaboardClient: () => ({ send: async () => { writes++; } }) });
  try {
    await app.runOnce();
    assert.equal(writes, 0);
    assert.match(app.actions.status().configError ?? "", /ORCHESTRATOR_INTERVAL_MINUTES/);
    assert.doesNotMatch(app.actions.status().configError ?? "", /bad/);
    await assert.rejects(stat(join(directory, "config.json")));
  } finally { await app.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("web application can configure an unconnected board and preview without sending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vbmux-app-"));
  const store = await ConfigStore.open(directory, { CODEX_QUOTA_SOURCE: "fixture", VESTABOARD_BOARD: "note" });
  const app = await createApplication(store, directory, false);
  try {
    await app.start();
    const initial = app.actions.status() as { configError?: string; lastSent?: unknown };
    assert.equal(app.actions.status().dryRun, false);
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
