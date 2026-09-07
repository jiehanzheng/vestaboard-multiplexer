import assert from "node:assert/strict";
import { constants } from "node:fs";
import test from "node:test";

import {
  CodexAppServerError,
  isMatchingTurnCompletion,
  parseModelListResult,
  turnCompletionFailure,
  type CodexAppServerClient,
  type RateLimitsResult
} from "../src/plugins/codexQuota/appServer.js";
import { CodexAutoStartSidecar } from "../src/plugins/codexQuota/autoStartSidecar.js";
import {
  CodexQuotaPlugin,
  formatError,
  formatQuota as formatQuotaWindows,
  QuotaWindowHistory,
  quotaFromRateLimits,
  quotaWindowLabel,
  type QuotaSnapshot,
  type QuotaWindow,
  selectAutoStartModel
} from "../src/plugins/codexQuota/index.js";
import { BLACK, BLUE, GREEN, ORANGE, RED, VIOLET, WHITE, YELLOW } from "../src/plugins/codexQuota/display/shared.js";
import { classifyCodexFailure, inspectCodexAuthStorage } from "../src/plugins/codexQuota/failure.js";
import { StatusMessageStack } from "../src/plugins/codexQuota/pluginState.js";
import { readRateLimitsWithAuthRecovery } from "../src/plugins/codexQuota/quotaSource.js";
import { formatStartupMessage } from "../src/startupMessage.js";
import { createVestaboardBoardResolver, boardPreferenceFromEnv } from "../src/vestaboardBoard.js";
import {
  createVestaboardClient,
  detectLocalVestaboardBoard,
  detectVestaboardBoard,
  localMessageTransitionOptionsFromEnv
} from "../src/vestaboard.js";

test("renders startup message with date time and enabled plugin slugs for Vestaboard Note", () => {
  const message = formatStartupMessage({
    plugins: [
      { id: "codex-quota", slug: "codex" }
    ],
    now: new Date("2026-06-24T14:19:00-07:00"),
    timeZone: "America/Los_Angeles",
    board: "note",
    transport: "local"
  });

  assert.equal(message.text, "VBMUX VIA LOCAL\n20260624 1419  \nCODEX          ");
  assert.deepEqual(message.characters?.[0], [22, 2, 13, 21, 24, 0, 22, 9, 1, 0, 12, 15, 3, 1, 12]);
});

test("renders comma-separated startup plugin slugs without spaces", () => {
  const message = formatStartupMessage({
    plugins: [
      { id: "codex-quota", slug: "codex" },
      { id: "weather" }
    ],
    now: new Date("2026-06-24T21:19:00Z"),
    board: "flagship",
    transport: "cloud"
  });

  assert.equal(message.text.split("\n")[0], "VBMUX VIA CLOUD       ");
  assert.equal(message.text.split("\n")[2], "CODEX,WEATHER         ");
});

test("renders startup status on the last physical row", () => {
  const message = formatStartupMessage({
    plugins: [
      { id: "codex-quota", slug: "codex" }
    ],
    now: new Date("2026-06-24T21:19:00Z"),
    board: "flagship",
    transport: "local",
    statusLine: "check logs"
  });

  const rows = message.text.split("\n");
  assert.equal(rows[2], "CODEX                 ");
  assert.equal(rows[5], "CHECK LOGS            ");
});

test("uses aggregate rateLimits primary and secondary windows", () => {
  const snapshot = quotaFromRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1_781_862_240 },
      secondary: { usedPercent: 66, windowDurationMins: 10_080, resetsAt: 1_782_076_740 }
    },
    rateLimitsByLimitId: {
      codex_bengalfox: {
        limitId: "codex_bengalfox",
        primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1_781_869_432 },
        secondary: { usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_782_079_599 }
      }
    }
  });

  assert.deepEqual(snapshot.windows.map((window) => window.id), ["primary", "secondary"]);
  assert.equal(snapshot.windows[0]?.remainingRatio, 0.99);
  assert.equal(snapshot.windows[1]?.remainingRatio, 0.34);
  assert.equal(snapshot.windows[0]?.durationMins, 300);
  assert.equal(snapshot.windows[1]?.durationMins, 10_080);
  assert.equal(snapshot.windows[0]?.resetAt?.toISOString(), "2026-06-19T09:44:00.000Z");
  assert.equal(snapshot.windows[1]?.resetAt?.toISOString(), "2026-06-21T21:19:00.000Z");
});

test("sorts arbitrary aggregate windows by duration and ignores per-limit buckets", () => {
  const snapshot = quotaFromRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 120, windowDurationMins: 12_960, resetsAt: null },
      secondary: { usedPercent: -5, windowDurationMins: 240 }
    },
    rateLimitsByLimitId: {
      ignored: {
        limitId: "ignored",
        primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1_781_862_240 }
      }
    }
  });

  assert.deepEqual(snapshot.windows.map(({ id, remainingRatio, durationMins, resetAt }) => ({
    id,
    remainingRatio,
    durationMins,
    resetAt
  })), [
    { id: "secondary", remainingRatio: 1, durationMins: 240, resetAt: undefined },
    { id: "primary", remainingRatio: 0, durationMins: 12_960, resetAt: undefined }
  ]);
});

test("accepts an empty aggregate bucket without borrowing other quota modes", () => {
  const snapshot = quotaFromRateLimits({
    rateLimits: null,
    rateLimitsByLimitId: {
      ignored: {
        limitId: "ignored",
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_781_862_240 }
      }
    }
  });

  assert.deepEqual(snapshot, { windows: [] });
});

test("sorts unknown durations last and preserves slot order for duration ties", () => {
  const unknownLast = quotaFromRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 10, windowDurationMins: null, resetsAt: 1_781_862_240 },
      secondary: { usedPercent: 20, windowDurationMins: 360, resetsAt: 1_781_862_240 }
    }
  });
  const tied = quotaFromRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 10, windowDurationMins: 360, resetsAt: 1_781_862_240 },
      secondary: { usedPercent: 20, windowDurationMins: 360, resetsAt: 1_781_862_240 }
    }
  });

  assert.deepEqual(unknownLast.windows.map((window) => window.id), ["secondary", "primary"]);
  assert.equal(unknownLast.windows[1]?.durationMins, undefined);
  assert.deepEqual(tied.windows.map((window) => window.id), ["primary", "secondary"]);
});

test("derives compact quota labels entirely from duration", () => {
  const cases = [
    [240, "4H"],
    [300, "5H"],
    [360, "6H"],
    [8_640, "6D"],
    [12_960, "9D"],
    [10_080, "WK"],
    [20_160, "2W"]
  ] as const;

  for (const [durationMins, expected] of cases) {
    assert.equal(quotaWindowLabel({ id: "slot", remainingRatio: 0.5, durationMins }, 0), expected);
  }
});

test("falls back to final quota position when duration cannot fit in two characters", () => {
  assert.equal(quotaWindowLabel({ id: "slot", remainingRatio: 0.5, durationMins: 600 }, 0), "Q1");
  assert.equal(quotaWindowLabel({ id: "slot", remainingRatio: 0.5, durationMins: 15 }, 1), "Q2");
  assert.equal(quotaWindowLabel({ id: "slot", remainingRatio: 0.5, durationMins: 90 }, 0), "Q1");
  assert.equal(quotaWindowLabel({ id: "slot", remainingRatio: 0.5 }, 1), "Q2");
});

test("renders partial quota when only the five-hour window is present", () => {
  const snapshot = quotaFromRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_781_862_240 },
      secondary: null
    }
  });

  const message = formatQuota(snapshot, {
    timeZone: "America/Los_Angeles",
    now: new Date("2026-06-18T22:44:00-07:00")
  });

  assert.equal(snapshot.windows.length, 1);
  assert.equal(message.text, "5HGGGGGGGW  80%\n               \n0244           ");
  assert.deepEqual(message.characters?.[1], Array(15).fill(0));
  assert.deepEqual(message.characters?.[2], [36, 28, 30, 30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const flagshipRows = formatQuota(snapshot, {
    board: "flagship",
    timeZone: "America/Los_Angeles",
    now: new Date("2026-06-18T22:44:00-07:00")
  }).text.split("\n");
  assert.equal(flagshipRows[3], " ".repeat(22));
  assert.equal(flagshipRows[4], " ".repeat(22));
});

test("derives WK when a weekly-only response arrives in primary", () => {
  const snapshot = quotaFromRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: 1_782_076_740 },
      secondary: null
    }
  });
  const note = formatQuota(snapshot, {
    timeZone: "America/Los_Angeles",
    now: new Date("2026-06-18T22:44:00-07:00"),
    showPacing: false
  });
  const autoStart = new QuotaWindowHistory().planAutoStart(
    { windows: [{ ...snapshot.windows[0]!, remainingRatio: 1 }] },
    { fiveHour: false, weekly: true },
    { force: false, now: new Date("2026-06-18T22:44:00-07:00") }
  );

  assert.equal(snapshot.windows[0]?.id, "primary");
  assert.match(note.text.split("\n")[0], /^WK/);
  assert.deepEqual(autoStart, {
    type: "ping",
    trigger: "unused-quota",
    windows: [{
      id: "duration:10080",
      row: "WK",
      resetAtMs: new Date("2026-06-21T21:19:00.000Z").getTime()
    }]
  });
});

test("renders fallback labels and leaves unavailable reset timing blank", () => {
  const message = formatQuota({
    windows: [
      { id: "primary", remainingRatio: 0.5, durationMins: 600 },
      { id: "secondary", remainingRatio: 0.4, durationMins: 15 }
    ]
  }, {
    showPacing: false,
    now: new Date("2026-06-19T00:00:00-07:00")
  });

  assert.match(message.text.split("\n")[0], /^Q1/);
  assert.match(message.text.split("\n")[1], /^Q2/);
  assert.equal(message.text.split("\n")[2], "               ");
});

test("renders zero quota windows as blank Note and Flagship meter rows", () => {
  const note = formatQuota({ windows: [] });
  const flagship = formatQuota({ windows: [] }, { board: "flagship" });

  assert.equal(note.text, "               \n               \n               ");
  assert.equal(note.characters?.flat().every((cell) => cell === 0), true);
  assert.equal(flagship.text.split("\n")[0], "CODEX REMAINING  RESET");
  assert.deepEqual(flagship.text.split("\n").slice(1), Array(5).fill(" ".repeat(22)));
  assert.equal(flagship.characters?.slice(1).flat().every((cell) => cell === 0), true);
});

test("renders remaining quota as green Vestaboard Note character codes", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.3, resetAt: new Date("2026-06-21T00:00:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00") }
  );

  assert.equal(message.text.split("\n")[0], "5HGGGGGGGGGW100");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 66, 66, 66, 66, 66, 66, 66, 66, 69, 27, 36, 36]);
  assert.equal(message.characters?.every((row) => row.length === 15), true);
});

test("renders documented Vestaboard punctuation character codes", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    {
      now: new Date("2026-06-18T21:44:00-07:00"),
      statusMessage: "!@#$()-+&=;:'\""
    }
  );

  assert.equal(message.text.split("\n")[2], "!@#$()-+&=;:'\" ");
  assert.deepEqual(message.characters?.[2], [37, 38, 39, 40, 41, 42, 44, 46, 47, 48, 49, 50, 52, 53, 0]);
});

test("renders documented comma period degree and heart character codes", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    {
      now: new Date("2026-06-18T21:44:00-07:00"),
      statusMessage: "punct,./?°♥"
    }
  );

  assert.equal(message.text.split("\n")[2], "PUNCT,./?°♥    ");
  assert.deepEqual(message.characters?.[2], [16, 21, 14, 3, 20, 55, 56, 59, 60, 62, 62, 0, 0, 0, 0]);
});

test("preserves official Vestaboard color character constants", () => {
  assert.deepEqual({ RED, ORANGE, YELLOW, GREEN, BLUE, VIOLET, WHITE, BLACK }, {
    RED: 63,
    ORANGE: 64,
    YELLOW: 65,
    GREEN: 66,
    BLUE: 67,
    VIOLET: 68,
    WHITE: 69,
    BLACK: 70
  });
});

test("renders equal-width 5-hour time marker buckets on Vestaboard Note", () => {
  const window = {
    remainingRatio: 1,
    resetAt: new Date("2026-06-19T05:00:00-07:00"),
    durationMins: 300
  };
  const snapshot = { fiveHour: window, weekly: undefined };

  assert.equal(formatQuota(snapshot, { now: new Date("2026-06-19T00:00:00-07:00") }).text.split("\n")[0].slice(2, 12), "GGGGGGGGGW");
  assert.equal(formatQuota(snapshot, { now: new Date("2026-06-19T00:29:59-07:00") }).text.split("\n")[0].slice(2, 12), "GGGGGGGGGW");
  assert.equal(formatQuota(snapshot, { now: new Date("2026-06-19T00:30:00-07:00") }).text.split("\n")[0].slice(2, 12), "GGGGGGGGWG");
  assert.equal(formatQuota(snapshot, { now: new Date("2026-06-19T04:59:00-07:00") }).text.split("\n")[0].slice(2, 12), "WGGGGGGGGG");
});

test("status message stack prunes expired messages before retaining new ones", () => {
  const stack = new StatusMessageStack();
  const retainedMessages = (): unknown[] => (stack as unknown as { messages: unknown[] }).messages;

  stack.push("first", new Date("2026-06-19T00:00:00-07:00"), 1_000);
  stack.push("second", new Date("2026-06-19T00:00:02-07:00"), 1_000);
  assert.equal(stack.top(new Date("2026-06-19T00:00:04-07:00")), undefined);
  assert.equal(retainedMessages().length, 1);
  stack.pushLow("third", new Date("2026-06-19T00:00:04-07:00"), 1_000);

  assert.equal(retainedMessages().length, 1);
  assert.equal(stack.top(new Date("2026-06-19T00:00:04-07:00")), "third");
});

test("renders full quota as 100 while preserving row width", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00") }
  );

  assert.equal(message.text.split("\n")[0], "5HGGGGGGGGGW100");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 66, 66, 66, 66, 66, 66, 66, 66, 69, 27, 36, 36]);
});

test("renders single-digit percentages without a leading zero while preserving row width", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.09, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00"), showPacing: false }
  );

  assert.equal(message.text.split("\n")[0], "5HG          9%");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 35, 54]);
  assert.equal(message.characters?.every((row) => row.length === 15), true);
});

test("does not render reset time for unused quota windows", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00") }
  );

  assert.equal(message.text.split("\n")[2], "               ");
  assert.deepEqual(message.characters?.[2], Array(15).fill(0));
});

test("renders reset time for full windows when reset visibility is supplied", () => {
  const snapshot = {
    fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
    weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
  };
  const message = formatQuota(snapshot, {
    timeZone: "America/Los_Angeles",
    now: new Date("2026-06-18T21:44:00-07:00"),
    resetVisibility: { fiveHour: true, weekly: true }
  });

  assert.equal(message.text.split("\n")[2], "0244♥06/24-1419");
});

test("quota window history shows full-window resets after two matching fresh timestamps", () => {
  const history = new QuotaWindowHistory();
  const first = quotaSnapshot({ fiveHour: 1, weekly: 1 });
  history.recordFreshSnapshot(first);
  assert.deepEqual(history.resetVisibilityFor(first), { primary: false, secondary: false });

  const second = quotaSnapshot({ fiveHour: 1, weekly: 1 });
  history.recordFreshSnapshot(second);
  assert.deepEqual(history.resetVisibilityFor(second), { primary: true, secondary: true });

  const changed = normalizeQuotaSnapshot({
    fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 },
    weekly: windowForDuration(second, 10_080)
  });
  history.recordFreshSnapshot(changed);
  assert.deepEqual(history.resetVisibilityFor(changed), { primary: false, secondary: true });

  history.recordFreshSnapshot(changed);
  assert.deepEqual(history.resetVisibilityFor(changed), { primary: true, secondary: true });
});

test("quota window history shows used-window resets immediately", () => {
  const history = new QuotaWindowHistory();
  const snapshot = quotaSnapshot({ fiveHour: 0.995, weekly: 1 });
  history.recordFreshSnapshot(snapshot);

  assert.deepEqual(history.resetVisibilityFor(snapshot), { primary: true, secondary: false });
});

test("quota window history follows a known duration when its source slot changes", () => {
  const history = new QuotaWindowHistory();
  const resetAt = new Date("2026-06-24T14:19:00-07:00");
  const secondary = { windows: [{ id: "secondary", remainingRatio: 1, durationMins: 10_080, resetAt }] };
  const primary = { windows: [{ id: "primary", remainingRatio: 1, durationMins: 10_080, resetAt }] };

  history.recordFreshSnapshot(secondary);
  assert.deepEqual(history.resetVisibilityFor(secondary), { secondary: false });
  history.recordFreshSnapshot(primary);
  assert.deepEqual(history.resetVisibilityFor(primary), { primary: true });
});

test("quota window history keeps simultaneous equal-duration observations independent", () => {
  const matchingHistory = new QuotaWindowHistory();
  const matching = {
    windows: [
      { id: "primary", remainingRatio: 1, durationMins: 360, resetAt: new Date("2026-06-19T06:00:00-07:00") },
      { id: "secondary", remainingRatio: 1, durationMins: 360, resetAt: new Date("2026-06-19T06:00:00-07:00") }
    ]
  };

  matchingHistory.recordFreshSnapshot(matching);
  assert.deepEqual(matchingHistory.resetVisibilityFor(matching), { primary: false, secondary: false });
  matchingHistory.recordFreshSnapshot(matching);
  assert.deepEqual(matchingHistory.resetVisibilityFor(matching), { primary: true, secondary: true });

  const distinctHistory = new QuotaWindowHistory();
  const distinct = {
    windows: [
      { id: "primary", remainingRatio: 1, durationMins: 360, resetAt: new Date("2026-06-19T06:00:00-07:00") },
      { id: "secondary", remainingRatio: 1, durationMins: 360, resetAt: new Date("2026-06-19T07:00:00-07:00") }
    ]
  };

  distinctHistory.recordFreshSnapshot(distinct);
  assert.deepEqual(distinctHistory.resetVisibilityFor(distinct), { primary: false, secondary: false });
  distinctHistory.recordFreshSnapshot(distinct);
  assert.deepEqual(distinctHistory.resetVisibilityFor(distinct), { primary: true, secondary: true });
});

test("quota window history preserves observations when equal-duration collisions appear or disappear", () => {
  const resetAt = new Date("2026-06-19T06:00:00-07:00");
  const single = {
    windows: [{ id: "primary", remainingRatio: 1, durationMins: 360, resetAt }]
  };
  const collision = {
    windows: [
      { id: "primary", remainingRatio: 1, durationMins: 360, resetAt },
      { id: "secondary", remainingRatio: 1, durationMins: 360, resetAt }
    ]
  };

  const singleToCollision = new QuotaWindowHistory();
  singleToCollision.recordFreshSnapshot(single);
  assert.deepEqual(singleToCollision.resetVisibilityFor(single), { primary: false });
  singleToCollision.recordFreshSnapshot(collision);
  assert.deepEqual(singleToCollision.resetVisibilityFor(collision), { primary: true, secondary: true });

  const collisionToSingle = new QuotaWindowHistory();
  collisionToSingle.recordFreshSnapshot(collision);
  assert.deepEqual(collisionToSingle.resetVisibilityFor(collision), { primary: false, secondary: false });
  collisionToSingle.recordFreshSnapshot(single);
  assert.deepEqual(collisionToSingle.resetVisibilityFor(single), { primary: true });
});

test("formats two short resets as times and two long resets as dates on Note", () => {
  const short = formatQuota({
    windows: [
      { id: "primary", remainingRatio: 0.5, durationMins: 240, resetAt: new Date("2026-06-19T01:00:00-07:00") },
      { id: "secondary", remainingRatio: 0.5, durationMins: 360, resetAt: new Date("2026-06-19T02:00:00-07:00") }
    ]
  }, { timeZone: "America/Los_Angeles", showPacing: false });
  const long = formatQuota({
    windows: [
      { id: "primary", remainingRatio: 0.5, durationMins: 8_640, resetAt: new Date("2026-06-24T01:00:00-07:00") },
      { id: "secondary", remainingRatio: 0.5, durationMins: 12_960, resetAt: new Date("2026-06-28T02:00:00-07:00") }
    ]
  }, { timeZone: "America/Los_Angeles", showPacing: false });

  assert.equal(short.text.split("\n")[2], "0100♥0200      ");
  assert.equal(long.text.split("\n")[2], "06/24♥06/28    ");
});

test("renders reset time only for the used five-hour quota window", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.99, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00") }
  );

  assert.equal(message.text.split("\n")[2], "0244           ");
});

test("renders reset date and time only for the used weekly quota window", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.99, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-18T21:44:00-07:00") }
  );

  assert.equal(message.text.split("\n")[2], "06/24-1419     ");
});

test("renders red quota fill and white time marker when quota is far behind expected remaining", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.3,
        resetAt: new Date("2026-06-19T03:00:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 0.6,
        resetAt: new Date("2026-06-22T00:00:00-07:00"),
        durationMins: 10_080
      }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );

  assert.equal(message.text, "5HRRR  W    30%\nWKGGGGWG    60%\n0300♥06/22-0000");
  assert.deepEqual(message.characters?.[0], [31, 8, 63, 63, 63, 0, 0, 69, 0, 0, 0, 0, 29, 36, 54]);
});

test("renders green quota fill and white time marker when quota is ahead of expected remaining", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.8,
        resetAt: new Date("2026-06-19T02:00:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 0.5,
        resetAt: new Date("2026-06-22T12:00:00-07:00"),
        durationMins: 10_080
      }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );

  assert.equal(message.text.split("\n")[0], "5HGGGWGGGG  80%");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 66, 66, 69, 66, 66, 66, 66, 0, 0, 34, 36, 54]);
});

test("renders yellow quota fill when quota is slightly behind expected remaining", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.35,
        resetAt: new Date("2026-06-19T02:00:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 1,
        resetAt: new Date("2026-06-24T14:19:00-07:00"),
        durationMins: 10_080
      }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );

  assert.equal(message.text.split("\n")[0], "5HYYYW      35%");
  assert.deepEqual(message.characters?.[0], [31, 8, 65, 65, 65, 69, 0, 0, 0, 0, 0, 0, 29, 31, 54]);
});

test("renders orange quota fill when quota is moderately behind expected remaining", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.3,
        resetAt: new Date("2026-06-19T02:00:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 1,
        resetAt: new Date("2026-06-24T14:19:00-07:00"),
        durationMins: 10_080
      }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );

  assert.equal(message.text.split("\n")[0], "5HOOOW      30%");
  assert.deepEqual(message.characters?.[0], [31, 8, 64, 64, 64, 69, 0, 0, 0, 0, 0, 0, 29, 36, 54]);
});

test("renders only the white marker when it covers the only quota cell", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.05,
        resetAt: new Date("2026-06-19T00:10:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 1,
        resetAt: new Date("2026-06-24T14:19:00-07:00"),
        durationMins: 10_080
      }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );

  assert.equal(message.text.split("\n")[0], "5HW          5%");
  assert.deepEqual(message.characters?.[0], [31, 8, 69, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 31, 54]);
});

test("renders white marker without quota fill when quota is empty but time remains", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0,
        resetAt: new Date("2026-06-19T02:00:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 1,
        resetAt: new Date("2026-06-24T14:19:00-07:00"),
        durationMins: 10_080
      }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );

  assert.equal(message.text.split("\n")[0], "5H   W       0%");
  assert.deepEqual(message.characters?.[0], [31, 8, 0, 0, 0, 69, 0, 0, 0, 0, 0, 0, 0, 36, 54]);
});

test("renders one Note quota block when quota reaches into the first bucket", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.04,
        resetAt: new Date("2026-06-19T02:00:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 1,
        resetAt: new Date("2026-06-24T14:19:00-07:00"),
        durationMins: 10_080
      }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );

  assert.deepEqual(message.characters?.[0], [31, 8, RED, 0, 0, WHITE, 0, 0, 0, 0, 0, 0, 0, 30, 54]);
});

test("renders two Note quota blocks when quota reaches into the second bucket", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.11,
        resetAt: new Date("2026-06-19T03:00:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 1,
        resetAt: new Date("2026-06-24T14:19:00-07:00"),
        durationMins: 10_080
      }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00"), showPacing: false }
  );

  assert.equal(message.text.split("\n")[0], "5HGG        11%");
});

test("renders only green quota blocks when pacing is hidden", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.3,
        resetAt: new Date("2026-06-19T03:00:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 0.6,
        resetAt: new Date("2026-06-22T00:00:00-07:00"),
        durationMins: 10_080
      }
    },
    { timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00"), showPacing: false, staleRows: ["WK"] }
  );

  assert.equal(message.text, "5HGGG       30%\nWKGGGGGG    60%\n0300♥06/22-0000");
  assert.deepEqual(message.characters?.[0], [31, 8, 66, 66, 66, 0, 0, 0, 0, 0, 0, 0, 29, 36, 54]);
  assert.equal(message.text.includes("?"), false);
  assert.equal(message.characters?.flat().includes(63), false);
  assert.equal(message.characters?.flat().includes(67), false);
});

test("renders Flagship quota as six 22-column rows with centered 20-column bars", () => {
  const message = formatQuota(
    {
      fiveHour: {
        remainingRatio: 0.77,
        resetAt: new Date("2026-06-19T20:25:00-07:00"),
        durationMins: 300
      },
      weekly: {
        remainingRatio: 0.06,
        resetAt: new Date("2026-06-24T14:19:00-07:00"),
        durationMins: 10_080
      }
    },
    {
      board: "flagship",
      timeZone: "America/Los_Angeles",
      now: new Date("2026-06-19T00:00:00-07:00"),
      showPacing: false,
      resetVisibility: { fiveHour: true, weekly: true }
    }
  );
  const rows = message.text.split("\n");

  assert.equal(rows.length, 6);
  assert.equal(rows.every((row) => row.length === 22), true);
  assert.equal(message.characters?.length, 6);
  assert.equal(message.characters?.every((row) => row.length === 22), true);
  assert.equal(rows[0], "CODEX REMAINING  RESET");
  assert.equal(rows[1], "5H    77%        20:25");
  assert.equal(rows[2][0], " ");
  assert.equal(rows[2].slice(1, 21), "GGGGGGGGGGGGGGGG    ");
  assert.equal(rows[2][21], " ");
  assert.equal(rows[3], "WK    6%   06/24 14:19");
  assert.equal(rows[4][0], " ");
  assert.equal(rows[4].slice(1, 21), "GG                  ");
  assert.equal(rows[4][21], " ");
  assert.equal(rows[5], "                      ");
  assert.equal(rows[0].indexOf("REMAINING"), 6);
  assert.equal(rows[1].slice(6, 9), "77%");
  assert.equal(rows[3].slice(6, 8), "6%");
  assert.equal(rows[0].slice(-5), "RESET");
  assert.equal(rows[1].slice(-5), "20:25");
  assert.equal(rows[3].slice(-11), "06/24 14:19");
});

test("renders Flagship status override in the last row and truncates overflow", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.5, resetAt: new Date("2026-06-19T20:25:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.5, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    {
      board: "flagship",
      timeZone: "America/Los_Angeles",
      now: new Date("2026-06-19T00:00:00-07:00"),
      statusMessage: "timeout using cached weekly quota"
    }
  );

  assert.equal(message.text.split("\n")[5], "TIMEOUT USING CACHED W");
});

test("renders Flagship full quota as 100% in the aligned remaining field", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T20:25:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    {
      board: "flagship",
      timeZone: "America/Los_Angeles",
      now: new Date("2026-06-19T00:00:00-07:00"),
      showPacing: false,
      resetVisibility: { fiveHour: true, weekly: true }
    }
  );
  const rows = message.text.split("\n");

  assert.equal(rows[1], "5H    100%       20:25");
  assert.equal(rows[3], "WK    100% 06/24 14:19");
  assert.equal(rows[1].slice(6, 10), "100%");
  assert.equal(rows[3].slice(6, 10), "100%");
});

test("renders Flagship pacing-off bars without red or blue blocks", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.3, resetAt: new Date("2026-06-19T03:00:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.6, resetAt: new Date("2026-06-22T00:00:00-07:00"), durationMins: 10_080 }
    },
    { board: "flagship", timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00"), showPacing: false }
  );

  assert.equal(message.characters?.flat().includes(63), false);
  assert.equal(message.characters?.flat().includes(67), false);
  assert.equal(message.characters?.flat().includes(69), false);
  assert.equal(message.text.split("\n")[2].slice(1, 21), "GGGGGG              ");
});

test("renders Flagship ratio pacing with white marker on 20-cell bars", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:00:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.3, resetAt: new Date("2026-06-19T02:00:00-07:00"), durationMins: 300 }
    },
    { board: "flagship", timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );
  const rows = message.text.split("\n");

  assert.equal(rows.every((row) => row.length === 22), true);
  assert.equal(rows[2].slice(1, 21), "GGGGGGGWGGGGGGGG    ");
  assert.equal(rows[4].slice(1, 21), "OOOOOO W            ");
  assert.deepEqual(message.characters?.[4].slice(1, 10), [64, 64, 64, 64, 64, 64, 0, 69, 0]);
});

test("renders Flagship marker-only bar when the marker covers the only quota cell", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.03, resetAt: new Date("2026-06-19T00:07:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0, resetAt: new Date("2026-06-19T02:00:00-07:00"), durationMins: 300 }
    },
    { board: "flagship", timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );
  const rows = message.text.split("\n");

  assert.equal(rows[2].slice(1, 21), "W                   ");
  assert.equal(rows[4].slice(1, 21), "       W            ");
  assert.equal(message.characters?.[2][1], 69);
  assert.equal(message.characters?.[4][8], 69);
});

test("renders one Flagship quota block when quota reaches into the first bucket", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.02, resetAt: new Date("2026-06-19T02:00:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0, resetAt: new Date("2026-06-19T02:00:00-07:00"), durationMins: 300 }
    },
    { board: "flagship", timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00") }
  );
  const rows = message.text.split("\n");

  assert.equal(rows[2].slice(1, 21), "R      W            ");
});

test("renders two Flagship quota blocks when quota reaches into the second bucket", () => {
  const message = formatQuota(
    {
      fiveHour: { remainingRatio: 0.06, resetAt: new Date("2026-06-19T03:00:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0, resetAt: new Date("2026-06-19T02:00:00-07:00"), durationMins: 300 }
    },
    { board: "flagship", timeZone: "America/Los_Angeles", now: new Date("2026-06-19T00:00:00-07:00"), showPacing: false }
  );
  const rows = message.text.split("\n");

  assert.equal(rows[2].slice(1, 21), "GG                  ");
});

test("auto-start model selection skips spark and prefers the last nano model", () => {
  const selection = selectAutoStartModel([
    model("gpt-5.5", ["medium"]),
    model("gpt-5.3-codex-spark", ["low"]),
    model("gpt-5.4-mini", ["medium", "high"]),
    model("gpt-5.4-nano", ["low", "medium"])
  ]);

  assert.deepEqual(selection, {
    model: "gpt-5.4-nano",
    reasoningEffort: "low"
  });
});

test("auto-start model selection falls back to mini and then the last filtered model", () => {
  assert.deepEqual(selectAutoStartModel([
    model("gpt-5.5", ["medium"]),
    model("gpt-5.4-mini", ["low"]),
    model("gpt-5.3-codex-spark", ["low"])
  ]), {
    model: "gpt-5.4-mini",
    reasoningEffort: "low"
  });
  assert.deepEqual(selectAutoStartModel([
    model("gpt-5.5", ["low"]),
    model("gpt-5.4", ["medium"]),
    model("gpt-5.3-codex-spark", ["low"])
  ]), {
    model: "gpt-5.4",
    reasoningEffort: "medium"
  });
});

test("model list parser permits omitted reasoning efforts on unselected models", () => {
  const models = parseModelListResult({
    data: [
      { id: "spark", model: "gpt-5.3-codex-spark" },
      { id: "regular", model: "gpt-5.5", supportedReasoningEfforts: null },
      {
        id: "nano",
        model: "gpt-5.4-nano",
        supportedReasoningEfforts: [{ reasoningEffort: "low" }]
      }
    ],
    nextCursor: null
  }).data;

  assert.deepEqual(selectAutoStartModel(models), {
    model: "gpt-5.4-nano",
    reasoningEffort: "low"
  });
});

test("model selection rejects when the selected model has no reasoning effort", () => {
  const models = parseModelListResult({
    data: [
      { id: "nano", model: "gpt-5.4-nano" }
    ],
    nextCursor: null
  }).data;

  assert.throws(() => selectAutoStartModel(models), /did not include a reasoning effort/);
});

test("auto-start planner selects enabled unused windows and skips disabled or used windows", () => {
  const state = new QuotaWindowHistory();
  const now = new Date("2026-06-19T00:00:00-07:00");

  assert.deepEqual(state.planAutoStart(quotaSnapshot({ fiveHour: 1, weekly: 0.99 }), { fiveHour: false, weekly: false }, { force: false, now }), {
    type: "skip",
    reason: "no-eligible-window"
  });
  assert.deepEqual(state.planAutoStart(quotaSnapshot({ fiveHour: 1, weekly: 0.99 }), { fiveHour: true, weekly: false }, { force: false, now }), {
    type: "ping",
    trigger: "unused-quota",
    windows: [{ id: "duration:300", row: "5H", resetAtMs: new Date("2026-06-19T09:44:00.000Z").getTime() }]
  });
  assert.deepEqual(state.planAutoStart(quotaSnapshot({ fiveHour: 0.99, weekly: 1 }), { fiveHour: true, weekly: false }, { force: false, now }), {
    type: "skip",
    reason: "no-eligible-window"
  });
});

test("auto-start planner records attempted windows and allows a newer reset timestamp", () => {
  const state = new QuotaWindowHistory();
  const firstNow = new Date("2026-06-19T00:00:00-07:00");
  const first = state.planAutoStart(quotaSnapshot({ fiveHour: 1, weekly: 1 }), { fiveHour: true, weekly: true }, { force: false, now: firstNow });
  assert.equal(first.type, "ping");
  assert.equal(first.type === "ping" ? first.windows.length : 0, 2);

  if (first.type === "ping") {
    state.recordPingAttempt(first, firstNow);
  }

  assert.deepEqual(state.planAutoStart(quotaSnapshot({ fiveHour: 1, weekly: 1 }), { fiveHour: true, weekly: true }, { force: false, now: new Date("2026-06-19T00:30:00-07:00") }), {
    type: "skip",
    reason: "no-eligible-window"
  });

  const newer = state.planAutoStart(normalizeQuotaSnapshot({
    fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 },
    weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
  }), { fiveHour: true, weekly: true }, { force: false, now: new Date("2026-06-19T00:31:00-07:00") });

  assert.deepEqual(newer, {
    type: "ping",
    trigger: "unused-quota",
    windows: [{ id: "duration:300", row: "5H", resetAtMs: new Date("2026-06-19T14:44:00.000Z").getTime() }]
  });
});

test("auto-start planner preserves attempts when equal-duration collisions appear or disappear", () => {
  const resetAt = new Date("2026-06-19T05:00:00-07:00");
  const single = {
    windows: [{ id: "primary", remainingRatio: 1, durationMins: 300, resetAt }]
  };
  const collision = {
    windows: [
      { id: "primary", remainingRatio: 1, durationMins: 300, resetAt },
      { id: "secondary", remainingRatio: 1, durationMins: 300, resetAt }
    ]
  };
  const config = { fiveHour: true, weekly: false };
  const firstNow = new Date("2026-06-19T00:00:00-07:00");
  const afterCooldown = new Date("2026-06-19T00:31:00-07:00");

  for (const [firstSnapshot, nextSnapshot] of [[single, collision], [collision, single]]) {
    const history = new QuotaWindowHistory();
    const first = history.planAutoStart(firstSnapshot, config, { force: false, now: firstNow });
    assert.equal(first.type, "ping");
    assert.equal(first.type === "ping" ? first.windows.length : 0, 1);
    if (first.type === "ping") {
      history.recordPingAttempt(first, firstNow);
    }

    assert.deepEqual(history.planAutoStart(nextSnapshot, config, { force: false, now: afterCooldown }), {
      type: "skip",
      reason: "no-eligible-window"
    });
  }
});

test("auto-start planner applies cooldown after ping attempts", () => {
  const state = new QuotaWindowHistory();
  const snapshot = quotaSnapshot({ fiveHour: 1, weekly: 0.5 });
  const now = new Date("2026-06-19T00:00:00-07:00");
  const first = state.planAutoStart(snapshot, { fiveHour: true, weekly: false }, { force: false, now });
  assert.equal(first.type, "ping");
  assert.equal(state.planAutoStart(snapshot, { fiveHour: true, weekly: false }, { force: false, now }).type, "ping");

  if (first.type === "ping") {
    state.recordPingAttempt(first, now);
  }

  assert.deepEqual(state.planAutoStart(normalizeQuotaSnapshot({
    fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 }
  }), { fiveHour: true, weekly: false }, { force: false, now: new Date("2026-06-19T00:29:59-07:00") }), {
    type: "skip",
    reason: "cooldown"
  });
  assert.equal(state.planAutoStart(normalizeQuotaSnapshot({
    fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 }
  }), { fiveHour: true, weekly: false }, { force: false, now: new Date("2026-06-19T00:30:00-07:00") }).type, "ping");
});

test("auto-start planner force mode bypasses flags quota records and cooldown without marking windows", () => {
  const state = new QuotaWindowHistory();
  const firstNow = new Date("2026-06-19T00:00:00-07:00");
  const normal = state.planAutoStart(quotaSnapshot({ fiveHour: 1, weekly: 0.5 }), { fiveHour: true, weekly: false }, { force: false, now: firstNow });
  assert.equal(normal.type, "ping");
  if (normal.type === "ping") {
    state.recordPingAttempt(normal, firstNow);
  }

  const force = state.planAutoStart(quotaSnapshot({ fiveHour: 0.8, weekly: 0.4 }), { fiveHour: false, weekly: false }, { force: true, now: new Date("2026-06-19T00:01:00-07:00") });
  assert.deepEqual(force, { type: "ping", trigger: "force", windows: [] });
  if (force.type === "ping") {
    state.recordPingAttempt(force, new Date("2026-06-19T00:01:00-07:00"));
  }

  assert.deepEqual(state.planAutoStart(quotaSnapshot({ fiveHour: 1, weekly: 0.5 }), { fiveHour: true, weekly: false }, { force: false, now: new Date("2026-06-19T00:31:00-07:00") }), {
    type: "skip",
    reason: "no-eligible-window"
  });
});

test("codex plugin shows full-window reset time after two matching fresh ticks", async () => {
  let reads = 0;
  const plugin = testCodexQuotaPlugin(async () => {
    reads += 1;
    return quotaPollResult({
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 1, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    });
  }, {
    timeZone: "America/Los_Angeles",
    now: () => new Date("2026-06-18T21:44:00-07:00")
  });

  const first = await collectAndRender(plugin);
  const second = await collectAndRender(plugin);

  assert.equal(reads, 2);
  assert.equal(first.message.text.split("\n")[2], "               ");
  assert.equal(second.message.text.split("\n")[2], "0244♥06/24-1419");
});

test("codex plugin hides a changed full-window reset until it repeats", async () => {
  const snapshots = [
    quotaSnapshot({ fiveHour: 1, weekly: 1 }),
    quotaSnapshot({ fiveHour: 1, weekly: 1 }),
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 },
      weekly: windowForDuration(quotaSnapshot({ weekly: 1 }), 10_080)
    },
    {
      fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 },
      weekly: windowForDuration(quotaSnapshot({ weekly: 1 }), 10_080)
    }
  ];
  let reads = 0;
  const plugin = testCodexQuotaPlugin(async () => quotaPollResult(snapshots[reads++] ?? snapshots.at(-1)!), {
    timeZone: "America/Los_Angeles",
    now: () => new Date("2026-06-19T00:00:00-07:00")
  });

  await collectAndRender(plugin);
  await collectAndRender(plugin);
  const changed = await collectAndRender(plugin);
  const repeated = await collectAndRender(plugin);

  assert.equal(changed.message.text.split("\n")[2], "06/24-1419     ");
  assert.equal(repeated.message.text.split("\n")[2], "0744♥06/24-1419");
});

test("codex plugin retains ping status-message messages until expiration", async () => {
  let now = new Date("2026-06-19T00:00:00-07:00");
  let reads = 0;
  const snapshot = {
    fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
    weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
  };
  const plugin = testCodexQuotaPlugin(async () => {
    reads += 1;
    return reads === 1 ? { snapshot, statusMessage: "ping gpt5.4minilow" } : quotaPollResult(snapshot);
  }, {timeZone: "America/Los_Angeles", now: () => now });

  const first = await collectAndRender(plugin);
  now = new Date("2026-06-19T00:04:00-07:00");
  const retained = await collectAndRender(plugin);
  now = new Date("2026-06-19T00:06:00-07:00");
  const expired = await collectAndRender(plugin);

  assert.equal(first.message.text.split("\n")[2], "PING GPT5.4MINI");
  assert.equal(retained.message.text.split("\n")[2], "PING GPT5.4MINI");
  assert.deepEqual(first.message.characters?.[2], [16, 9, 14, 7, 0, 7, 16, 20, 31, 56, 30, 13, 9, 14, 9]);
  assert.equal(expired.message.text.split("\n")[2], "0244♥06/24-1419");
});

test("codex plugin shows newer fetch failure above retained ping message", async () => {
  let now = new Date("2026-06-19T00:00:00-07:00");
  let reads = 0;
  let fail = false;
  const snapshot = {
    fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
    weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
  };
  const plugin = testCodexQuotaPlugin(async () => {
    if (fail) {
      throw new Error("Codex app-server timed out after 10000ms.");
    }

    reads += 1;
    return reads === 1 ? { snapshot, statusMessage: "ping gpt5.4minilow" } : quotaPollResult(snapshot);
  }, {timeZone: "America/Los_Angeles", logger: { warn() {} }, now: () => now });

  await collectAndRender(plugin);
  now = new Date("2026-06-19T00:04:00-07:00");
  fail = true;
  const fallback = await collectAndRender(plugin);
  assert.equal(fallback.message.text.split("\n")[2], "TIMEOUT        ");
});

test("codex plugin replaces a two-window snapshot with a complete one-window snapshot", async () => {
  let now = new Date("2026-06-19T00:00:00-07:00");
  let partial = false;
  const plugin = testCodexQuotaPlugin(async () => {
    if (partial) {
      return quotaPollResult({
        fiveHour: { remainingRatio: 0.7, resetAt: new Date("2026-06-19T03:00:00-07:00"), durationMins: 300 }
      });
    }

    return {
      snapshot: {
        fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
        weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
      },
      statusMessage: "ping gpt5.4minilow"
    };
  }, {timeZone: "America/Los_Angeles", logger: { warn() {} }, now: () => now });

  await collectAndRender(plugin);
  now = new Date("2026-06-19T00:04:00-07:00");
  partial = true;
  const fallback = await collectAndRender(plugin);
  assert.match(fallback.message.text.split("\n")[0], /^5H/);
  assert.equal(fallback.message.text.split("\n")[1], "               ");
  assert.equal(fallback.message.text.split("\n")[2], "PING GPT5.4MINI");
});

test("app-server turn completion matching accepts events without threadId", () => {
  assert.equal(isMatchingTurnCompletion({ turn: { id: "turn-1" } }, "thread-1", "turn-1"), true);
  assert.equal(isMatchingTurnCompletion({ threadId: "thread-1", turn: { id: "turn-1" } }, "thread-1", "turn-1"), true);
  assert.equal(isMatchingTurnCompletion({ threadId: "thread-2", turn: { id: "turn-1" } }, "thread-1", "turn-1"), false);
  assert.equal(isMatchingTurnCompletion({ turn: { id: "turn-2" } }, "thread-1", "turn-1"), false);
});

test("app-server turn completion only treats completed as success", () => {
  assert.equal(turnCompletionFailure({ status: "completed" }), undefined);
  assert.match(turnCompletionFailure({ status: "failed", error: "boom" })?.message ?? "", /status failed/);
  assert.match(turnCompletionFailure({ status: "interrupted" })?.message ?? "", /status interrupted/);
  assert.match(turnCompletionFailure({})?.message ?? "", /status unknown/);
});

test("codex failures classify expired authentication before the rate-limit endpoint name", () => {
  const expired = expiredTokenError();

  assert.deepEqual(classifyCodexFailure(expired), {
    reason: "auth_expired",
    boardStatus: "AUTH EXPIRED",
    authenticationFailure: true
  });
  assert.equal(classifyCodexFailure(new Error("failed to fetch codex rate limits")).reason, "unknown");
  assert.equal(classifyCodexFailure(new Error("HTTP 429 too_many_requests")).reason, "rate_limit");
  assert.deepEqual(classifyCodexFailure(new Error("HTTP 401 Unauthorized")), {
    reason: "auth_required",
    boardStatus: "LOGIN NEEDED",
    authenticationFailure: true
  });
});

test("quota reads force one token refresh and retry once after expired authentication", async () => {
  let quotaReads = 0;
  const refreshParams: Array<{ refreshToken: boolean }> = [];
  const expected = rateLimitsResult(25);
  const client = quotaClient({
    async readAccount(params) {
      refreshParams.push(params);
      return { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
    },
    async readRateLimits() {
      quotaReads += 1;
      if (quotaReads === 1) throw expiredTokenError();
      return expected;
    }
  });

  assert.equal(await readRateLimitsWithAuthRecovery(client), expected);
  assert.equal(quotaReads, 2);
  assert.deepEqual(refreshParams, [{ refreshToken: true }]);
});

test("quota reads stop after one failed token refresh", async () => {
  let quotaReads = 0;
  let refreshes = 0;
  const client = quotaClient({
    async readAccount() {
      refreshes += 1;
      throw new Error("refresh token revoked");
    },
    async readRateLimits() {
      quotaReads += 1;
      throw expiredTokenError();
    }
  });

  await assert.rejects(async () => {
    await readRateLimitsWithAuthRecovery(client);
  }, (error) => classifyCodexFailure(error).reason === "auth_expired");
  assert.equal(quotaReads, 1);
  assert.equal(refreshes, 1);
});

test("quota reads stop after the retried request is still unauthorized", async () => {
  let quotaReads = 0;
  let refreshes = 0;
  const client = quotaClient({
    async readAccount() {
      refreshes += 1;
      return { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
    },
    async readRateLimits() {
      quotaReads += 1;
      throw expiredTokenError();
    }
  });

  await assert.rejects(async () => {
    await readRateLimitsWithAuthRecovery(client);
  }, (error) => classifyCodexFailure(error).reason === "auth_expired");
  assert.equal(quotaReads, 2);
  assert.equal(refreshes, 1);
});

test("quota reads do not refresh or retry generic and real rate-limit failures", async () => {
  for (const error of [new Error("failed to fetch codex rate limits"), new Error("HTTP 429 too_many_requests")]) {
    let quotaReads = 0;
    let refreshes = 0;
    const client = quotaClient({
      async readAccount() {
        refreshes += 1;
        return { account: null, requiresOpenaiAuth: true };
      },
      async readRateLimits() {
        quotaReads += 1;
        throw error;
      }
    });

    await assert.rejects(() => readRateLimitsWithAuthRecovery(client), error);
    assert.equal(quotaReads, 1);
    assert.equal(refreshes, 0);
  }
});

test("auth storage diagnostics inspect metadata and permissions without reading credentials", () => {
  const accessCalls: Array<{ path: string; mode: number }> = [];
  const diagnostics = inspectCodexAuthStorage({
    env: { CODEX_HOME: "/codex-home" },
    homeDirectory: "/ignored-home",
    exists: (path) => path === "/codex-home" || path === "/codex-home/auth.json",
    access: (path, mode) => {
      accessCalls.push({ path, mode });
      if (path.endsWith("auth.json") && mode === constants.W_OK) {
        throw new Error("read-only");
      }
    },
    modifiedAt: () => new Date("2026-08-08T12:00:00.000Z")
  });

  assert.deepEqual(diagnostics, {
    authFile: "/codex-home/auth.json",
    authFilePresent: true,
    authFileReadable: true,
    authFileWritable: false,
    authDirectoryWritable: true,
    authFileModifiedAt: "2026-08-08T12:00:00.000Z"
  });
  assert.deepEqual(accessCalls, [
    { path: "/codex-home/auth.json", mode: constants.R_OK },
    { path: "/codex-home/auth.json", mode: constants.W_OK },
    { path: "/codex-home", mode: constants.W_OK }
  ]);

  assert.deepEqual(inspectCodexAuthStorage({
    env: { CODEX_HOME: "/writable" },
    exists: () => true,
    access: () => {},
    modifiedAt: () => new Date("2026-08-08T12:30:00.000Z")
  }), {
    authFile: "/writable/auth.json",
    authFilePresent: true,
    authFileReadable: true,
    authFileWritable: true,
    authDirectoryWritable: true,
    authFileModifiedAt: "2026-08-08T12:30:00.000Z"
  });

  assert.deepEqual(inspectCodexAuthStorage({
    env: { CODEX_HOME: "/missing" },
    exists: () => false,
    access: () => {
      throw new Error("access should not be called");
    }
  }), {
    authFile: "/missing/auth.json",
    authFilePresent: false,
    authFileReadable: false,
    authFileWritable: false,
    authDirectoryWritable: false,
    authFileModifiedAt: undefined
  });
});

test("auto-start sidecar starts read-only threads without cwd", async () => {
  let threadStartParams: { sandbox?: string; cwd?: unknown } | undefined;
  const sidecar = new CodexAutoStartSidecar({ fiveHour: false, weekly: false });
  const client = {
    async readAccount() {
      throw new Error("unexpected readAccount");
    },
    async readRateLimits() {
      throw new Error("unexpected readRateLimits");
    },
    async readModels() {
      return {
        data: [model("gpt-5.4-mini", ["low"])],
        nextCursor: null
      };
    },
    async startThread(params: { sandbox?: string; cwd?: unknown }) {
      threadStartParams = params;
      return { thread: { id: "thread-1" } };
    },
    async startTurn() {
      return { turn: { id: "turn-1", status: "completed" } };
    },
    async waitForTurnCompletion() {}
  };

  const result = await sidecar.afterQuotaRead({
    client,
    snapshot: quotaSnapshot({ fiveHour: 0.4, weekly: 0.2 }),
    force: true,
    now: new Date("2026-06-19T00:00:00-07:00")
  });

  assert.equal(result.statusMessage, "ping gpt5.4minilow");
  assert.equal(threadStartParams?.sandbox, "read-only");
  assert.equal(Object.hasOwn(threadStartParams ?? {}, "cwd"), false);
});

test("auto-start sidecar rejects non-progress turn start statuses", async () => {
  const sidecar = new CodexAutoStartSidecar({ fiveHour: false, weekly: false });
  const client = {
    async readAccount() {
      throw new Error("unexpected readAccount");
    },
    async readRateLimits() {
      throw new Error("unexpected readRateLimits");
    },
    async readModels() {
      return {
        data: [model("gpt-5.4-mini", ["low"])],
        nextCursor: null
      };
    },
    async startThread() {
      return { thread: { id: "thread-1" } };
    },
    async startTurn() {
      return { turn: { id: "turn-1", status: "interrupted" } };
    },
    async waitForTurnCompletion() {}
  };

  await assert.rejects(() => sidecar.afterQuotaRead({
    client,
    snapshot: quotaSnapshot({ fiveHour: 0.4, weekly: 0.2 }),
    force: true,
    now: new Date("2026-06-19T00:00:00-07:00")
  }), /started with status interrupted/);
});

test("auto-start sidecar records attempts before model reads can fail", async () => {
  const history = new QuotaWindowHistory();
  const config = { fiveHour: true, weekly: false };
  const sidecar = new CodexAutoStartSidecar(config, history);
  const snapshot = quotaSnapshot({ fiveHour: 1, weekly: 0.4 });
  const now = new Date("2026-06-19T00:00:00-07:00");
  const client = {
    async readAccount() {
      throw new Error("unexpected readAccount");
    },
    async readRateLimits() {
      throw new Error("unexpected readRateLimits");
    },
    async readModels() {
      throw new Error("model/list failed");
    },
    async startThread() {
      throw new Error("unexpected startThread");
    },
    async startTurn() {
      throw new Error("unexpected startTurn");
    },
    async waitForTurnCompletion() {}
  };

  await assert.rejects(() => sidecar.afterQuotaRead({ client, snapshot, force: false, now }), /model\/list failed/);

  assert.deepEqual(history.planAutoStart(snapshot, config, { force: false, now: new Date("2026-06-19T00:31:00-07:00") }), {
    type: "skip",
    reason: "no-eligible-window"
  });
  assert.deepEqual(history.planAutoStart(normalizeQuotaSnapshot({
    fiveHour: { remainingRatio: 1, resetAt: new Date("2026-06-19T07:44:00-07:00"), durationMins: 300 },
    weekly: windowForDuration(snapshot, 10_080)
  }), config, { force: false, now: new Date("2026-06-19T00:29:59-07:00") }), {
    type: "skip",
    reason: "cooldown"
  });
});

test("auto-start sidecar records attempts before turn start can fail", async () => {
  const history = new QuotaWindowHistory();
  const config = { fiveHour: true, weekly: false };
  const sidecar = new CodexAutoStartSidecar(config, history);
  const snapshot = quotaSnapshot({ fiveHour: 1, weekly: 0.4 });
  const now = new Date("2026-06-19T00:00:00-07:00");
  const client = {
    async readAccount() {
      throw new Error("unexpected readAccount");
    },
    async readRateLimits() {
      throw new Error("unexpected readRateLimits");
    },
    async readModels() {
      return {
        data: [model("gpt-5.4-mini", ["low"])],
        nextCursor: null
      };
    },
    async startThread() {
      return { thread: { id: "thread-1" } };
    },
    async startTurn() {
      return { turn: { id: "turn-1", status: "interrupted" } };
    },
    async waitForTurnCompletion() {}
  };

  await assert.rejects(() => sidecar.afterQuotaRead({ client, snapshot, force: false, now }), /started with status interrupted/);

  assert.deepEqual(history.planAutoStart(snapshot, config, { force: false, now: new Date("2026-06-19T00:31:00-07:00") }), {
    type: "skip",
    reason: "no-eligible-window"
  });
});

test("auto-start sidecar records attempts before model selection can fail", async () => {
  const history = new QuotaWindowHistory();
  const config = { fiveHour: true, weekly: false };
  const sidecar = new CodexAutoStartSidecar(config, history);
  const snapshot = quotaSnapshot({ fiveHour: 1, weekly: 0.4 });
  const now = new Date("2026-06-19T00:00:00-07:00");
  const client = {
    async readAccount() {
      throw new Error("unexpected readAccount");
    },
    async readRateLimits() {
      throw new Error("unexpected readRateLimits");
    },
    async readModels() {
      return {
        data: [parseModelListResult({ data: [{ id: "nano", model: "gpt-5.4-nano" }] }).data[0]!],
        nextCursor: null
      };
    },
    async startThread() {
      throw new Error("unexpected startThread");
    },
    async startTurn() {
      throw new Error("unexpected startTurn");
    },
    async waitForTurnCompletion() {}
  };

  await assert.rejects(() => sidecar.afterQuotaRead({ client, snapshot, force: false, now }), /did not include a reasoning effort/);

  assert.deepEqual(history.planAutoStart(snapshot, config, { force: false, now: new Date("2026-06-19T00:31:00-07:00") }), {
    type: "skip",
    reason: "no-eligible-window"
  });
});

test("codex plugin keeps fresh quota display when auto-start sidecar fails", async () => {
  const warnings: unknown[][] = [];
  const plugin = testCodexQuotaPlugin(async () => ({
    snapshot: {
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    sidecarError: new Error("model/list failed")
  }), {timeZone: "America/Los_Angeles", logger: { warn: (...args) => warnings.push(args) } });

  const update = await collectAndRender(plugin);
  assert.match(update.message.text.split("\n")[0], /^5H/);
  assert.match(update.message.text.split("\n")[1], /^WK/);
  assert.equal(update.message.text.split("\n")[2], "AUTO PING FAIL ");
  assert.equal(warnings[0]?.[0], "Codex quota auto-start failed after quota read.");
  assert.deepEqual(warnings[0]?.[1], {
    reason: "unknown",
    errorName: "Error",
    errorMessage: "model/list failed",
    boardStatus: "AUTO PING FAIL"
  });
});

test("codex plugin shows reset available when weekly quota is exhausted and reset credit exists", async () => {
  const plugin = testCodexQuotaPlugin(async () => ({
    snapshot: {
      fiveHour: { remainingRatio: 0.6, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    rateLimitResetCreditsAvailableCount: 1
  }), {timeZone: "America/Los_Angeles" });

  const update = await collectAndRender(plugin);
  assert.equal(update.message.text.split("\n")[2], "RESET AVAILABLE");
});

test("codex plugin expires reset available after a later fetch omits reset credits", async () => {
  let reads = 0;
  let now = new Date("2026-06-19T00:00:00-07:00");
  const plugin = testCodexQuotaPlugin(async () => {
    reads += 1;
    return {
      snapshot: {
        fiveHour: { remainingRatio: 0.6, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
        weekly: { remainingRatio: 0, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
      },
      rateLimitResetCreditsAvailableCount: reads === 1 ? 1 : 0
    };
  }, {timeZone: "America/Los_Angeles", now: () => now });

  const first = await collectAndRender(plugin);
  const retained = await collectAndRender(plugin);
  now = new Date("2026-06-19T00:00:01-07:00");
  const second = await collectAndRender(plugin);
  assert.equal(first.message.text.split("\n")[2], "RESET AVAILABLE");
  assert.equal(retained.message.text.split("\n")[2], "RESET AVAILABLE");
  assert.equal(second.message.text.split("\n")[2], "0244♥06/24-1419");
});

test("codex plugin keeps stacked refresh message above reset available until it expires", async () => {
  let now = new Date("2026-06-19T00:00:00-07:00");
  let reads = 0;
  const plugin = testCodexQuotaPlugin(async () => {
    reads += 1;
    return {
      snapshot: {
        fiveHour: { remainingRatio: 0.6, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
        weekly: { remainingRatio: 0, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
      },
      statusMessage: reads === 1 ? "ping gpt5.4minilow" : undefined,
      rateLimitResetCreditsAvailableCount: 1
    };
  }, {timeZone: "America/Los_Angeles", now: () => now });

  const stacked = await collectAndRender(plugin);
  now = new Date("2026-06-19T00:04:00-07:00");
  const retained = await collectAndRender(plugin);
  now = new Date("2026-06-19T00:06:00-07:00");
  const resetAvailable = await collectAndRender(plugin);

  assert.equal(stacked.message.text.split("\n")[2], "PING GPT5.4MINI");
  assert.equal(retained.message.text.split("\n")[2], "PING GPT5.4MINI");
  assert.equal(resetAvailable.message.text.split("\n")[2], "RESET AVAILABLE");
});

test("codex plugin keeps sidecar error above reset available in the status-message stack", async () => {
  const plugin = testCodexQuotaPlugin(async () => ({
    snapshot: {
      fiveHour: { remainingRatio: 0.6, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    sidecarError: new Error("model/list failed"),
    rateLimitResetCreditsAvailableCount: 1
  }), {timeZone: "America/Los_Angeles", logger: { warn() {} } });

  const update = await collectAndRender(plugin);
  assert.equal(update.message.text.split("\n")[2], "AUTO PING FAIL ");
});

test("codex plugin shows reset available for an exhausted one-window snapshot", async () => {
  const plugin = testCodexQuotaPlugin(async () => ({
    snapshot: {
      weekly: { remainingRatio: 0, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    rateLimitResetCreditsAvailableCount: 1
  }), {timeZone: "America/Los_Angeles", logger: { warn() {} } });

  const update = await collectAndRender(plugin);
  assert.match(update.message.text.split("\n")[0], /^WK/);
  assert.equal(update.message.text.split("\n")[1], "               ");
  assert.equal(update.message.text.split("\n")[2], "RESET AVAILABLE");
});

test("codex plugin shows reset available when any displayed quota is exhausted", async () => {
  const plugin = testCodexQuotaPlugin(async () => ({
    snapshot: {
      windows: [{
        id: "primary",
        remainingRatio: 0,
        resetAt: new Date("2026-06-19T02:44:00-07:00"),
        durationMins: 300
      }]
    },
    rateLimitResetCreditsAvailableCount: 1
  }), {timeZone: "America/Los_Angeles" });

  const update = await collectAndRender(plugin);
  assert.equal(update.message.text.split("\n")[2], "RESET AVAILABLE");
});

test("codex plugin does not show reset available when weekly quota remains", async () => {
  const plugin = testCodexQuotaPlugin(async () => ({
    snapshot: {
      fiveHour: { remainingRatio: 0.6, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.01, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    },
    rateLimitResetCreditsAvailableCount: 1
  }), {timeZone: "America/Los_Angeles" });

  const update = await collectAndRender(plugin);
  assert.equal(update.message.text.split("\n")[2], "0244♥06/24-1419");
});

test("codex plugin returns an error message when quota read fails", async () => {
  const warnings: unknown[][] = [];
  const plugin = testCodexQuotaPlugin(async () => {
    throw new Error("invalid json from codex");
  }, {logger: { warn: (...args) => warnings.push(args) } });

  const update = await collectAndRender(plugin);
  assert.equal(update.message.text.split("\n")[0], "CODEX QUOTA ERR");
  assert.equal(update.message.characters?.every((row) => row.length === 15), true);
  assert.equal(warnings[0]?.[0], "Codex quota read failed.");
  assert.deepEqual(warnings[0]?.[1], {
    reason: "invalid_json",
    errorName: "Error",
    errorMessage: "invalid json from codex",
    cacheState: {
      hasSnapshot: false,
      windowCount: 0,
      updatedAt: undefined
    },
    vestaboardPreview: "CODEX QUOTA ERR | INVALID JSON FR | "
  });
});

test("codex plugin renders auth expired with and without cached quota on both boards", async () => {
  for (const board of ["note", "flagship"] as const) {
    const noCacheWarnings: unknown[][] = [];
    const noCachePlugin = testCodexQuotaPlugin(async () => {
      throw expiredTokenError();
    }, {
      board: async () => board,
      logger: { warn: (...args) => noCacheWarnings.push(args) }
    });

    const noCache = await collectAndRender(noCachePlugin);
    assert.match(noCache.message.text, /AUTH EXPIRED/);
    assert.equal((noCacheWarnings[0]?.[1] as { reason?: string }).reason, "auth_expired");
    assert.equal(
      typeof (noCacheWarnings[0]?.[1] as { authStorage?: { authFilePresent?: boolean } }).authStorage?.authFilePresent,
      "boolean"
    );

    let fail = false;
    const cachedPlugin = testCodexQuotaPlugin(async () => {
      if (fail) throw expiredTokenError();
      return quotaPollResult({
        fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
        weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
      });
    }, {
      board: async () => board,
      logger: { warn() {} }
    });

    await collectAndRender(cachedPlugin);
    fail = true;
    const cached = await collectAndRender(cachedPlugin);
    assert.match(cached.message.text, /AUTH EXPIRED/);
  }
});

test("codex plugin renders cached quota ingredients when a later quota read fails", async () => {
  const warnings: unknown[][] = [];
  let fail = false;
  const plugin = testCodexQuotaPlugin(async () => {
    if (fail) {
      throw new Error("Codex app-server timed out after 30000ms.");
    }

    return quotaPollResult({
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    });
  }, {timeZone: "America/Los_Angeles", logger: { warn: (...args) => warnings.push(args) } });

  const good = await collectAndRender(plugin);
  fail = true;
  const fallback = await collectAndRender(plugin);
  assert.equal(fallback.message.text.split("\n")[0].replace("?", " "), good.message.text.split("\n")[0]);
  assert.equal(fallback.message.text.split("\n")[1].replace("?", " "), good.message.text.split("\n")[1]);
  assert.equal(fallback.message.text.split("\n")[2], "TIMEOUT        ");
  assert.equal((warnings[0]?.[1] as { reason?: string }).reason, "timeout");
  assert.deepEqual((warnings[0]?.[1] as { cacheState?: { hasSnapshot: boolean; windowCount: number } }).cacheState, {
    hasSnapshot: true,
    windowCount: 2,
    updatedAt: (warnings[0]?.[1] as { cacheState?: { updatedAt?: string } }).cacheState?.updatedAt
  });
});

test("codex plugin shows fetch fail for generic cached quota read failures", async () => {
  let fail = false;
  const plugin = testCodexQuotaPlugin(async () => {
    if (fail) {
      throw new Error("Codex app-server error: invalid request");
    }

    return quotaPollResult({
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    });
  }, {timeZone: "America/Los_Angeles", logger: { warn() {} } });

  await collectAndRender(plugin);
  fail = true;
  const fallback = await collectAndRender(plugin);
  assert.equal(fallback.message.text.split("\n")[2], "FETCH FAIL     ");
});

test("codex collector logs only failure and recovery transitions", async () => {
  let reads = 0;
  const warnings: unknown[][] = [];
  const infos: unknown[][] = [];
  const plugin = testCodexQuotaPlugin(async () => {
    reads += 1;
    if (reads === 1) throw new Error("temporary quota outage");
    if (reads === 2) throw new Error("authentication outage");
    return { snapshot: { windows: [{ id: "primary", remainingRatio: 0.5, durationMins: 300 }] } };
  }, { logger: {
    warn: (...args) => warnings.push(args),
    info: (...args) => infos.push(args)
  } });
  await plugin.collect();
  await plugin.collect();
  await plugin.collect();
  assert.equal(warnings.length, 2);
  assert.equal(infos.length, 1);
  assert.match(String(infos[0]?.[0]), /recovered/i);
});

test("codex plugin does not merge an omitted window from an older snapshot", async () => {
  const warnings: unknown[][] = [];
  let partial = false;
  const plugin = testCodexQuotaPlugin(async () => {
    if (partial) {
      return quotaPollResult({
        fiveHour: { remainingRatio: 0.7, resetAt: new Date("2026-06-19T03:00:00-07:00"), durationMins: 300 }
      });
    }

    return quotaPollResult({
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    });
  }, {timeZone: "America/Los_Angeles", logger: { warn: (...args) => warnings.push(args) } });

  await collectAndRender(plugin);
  partial = true;
  const oneWindow = await collectAndRender(plugin);
  assert.match(oneWindow.message.text.split("\n")[0], /^5H/);
  assert.equal(oneWindow.message.text.split("\n")[1], "               ");
  assert.equal(oneWindow.message.text.split("\n")[2], "0300           ");
  assert.deepEqual(warnings, []);
});

test("codex plugin treats a successful empty snapshot as the complete cached state", async () => {
  let reads = 0;
  const plugin = testCodexQuotaPlugin(async () => {
    reads += 1;
    if (reads === 1) {
      return quotaPollResult({
        fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
        weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
      });
    }
    if (reads === 2) {
      return quotaPollResult({ windows: [] });
    }

    throw new Error("Codex app-server error: invalid request");
  }, {
    logger: { warn() {} }
  });

  await collectAndRender(plugin);
  const empty = await collectAndRender(plugin);
  const fallback = await collectAndRender(plugin);
  assert.equal(empty.message.text, "               \n               \n               ");
  assert.equal(fallback.message.text, "               \n               \nFETCH FAIL     ");
});

test("codex plugin recomputes cached ingredients instead of reusing rendered message", async () => {
  let fail = false;
  let now = new Date("2026-06-19T00:00:00-07:00");
  const plugin = testCodexQuotaPlugin(async () => {
    if (fail) {
      throw new Error("Codex app-server timed out after 10000ms.");
    }

    return quotaPollResult({
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:00:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    });
  }, {timeZone: "America/Los_Angeles", logger: { warn() {} }, now: () => now });

  const good = await collectAndRender(plugin);
  fail = true;
  now = new Date("2026-06-19T01:00:00-07:00");
  const fallback = await collectAndRender(plugin);

  assert.notEqual(fallback.message.text.split("\n")[0], good.message.text.split("\n")[0]);
  assert.equal(fallback.message.text.split("\n")[2], "TIMEOUT        ");
});

test("codex plugin expires transient error status after the next successful read", async () => {
  let fail = false;
  let now = new Date("2026-06-19T00:00:00-07:00");
  const plugin = testCodexQuotaPlugin(async () => {
    if (fail) {
      fail = false;
      throw new Error("Codex app-server timed out after 10000ms.");
    }

    return quotaPollResult({
      fiveHour: { remainingRatio: 0.8, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
      weekly: { remainingRatio: 0.4, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
    });
  }, {timeZone: "America/Los_Angeles", logger: { warn() {} }, now: () => now });

  await collectAndRender(plugin);
  fail = true;
  now = new Date("2026-06-19T00:01:00-07:00");
  const error = await collectAndRender(plugin);
  now = new Date("2026-06-19T00:01:00.500-07:00");
  const retained = await collectAndRender(plugin);
  now = new Date("2026-06-19T00:01:01-07:00");
  const expired = await collectAndRender(plugin);

  assert.equal(error.message.text.split("\n")[2], "TIMEOUT        ");
  assert.equal(retained.message.text.split("\n")[2], "TIMEOUT        ");
  assert.equal(expired.message.text.split("\n")[2], "0244♥06/24-1419");
});

test("codex plugin leaves an unused quota row blank", async () => {
  const plugin = testCodexQuotaPlugin(async () => quotaPollResult({
    fiveHour: { remainingRatio: 0.7, resetAt: new Date("2026-06-19T03:00:00-07:00"), durationMins: 300 }
  }), {timeZone: "America/Los_Angeles", logger: { warn() {} } });

  const update = await collectAndRender(plugin);
  assert.equal(update.message.text.split("\n")[1], "               ");
  assert.equal(update.message.text.split("\n")[2], "0300           ");
});

test("codex plugin can show board-size pending status in the Note status lane", async () => {
  const plugin = testCodexQuotaPlugin(async () => quotaPollResult({
    fiveHour: { remainingRatio: 0.7, resetAt: new Date("2026-06-19T03:00:00-07:00"), durationMins: 300 },
    weekly: { remainingRatio: 0.6, resetAt: new Date("2026-06-22T00:00:00-07:00"), durationMins: 10_080 }
  }), {
    timeZone: "America/Los_Angeles",
    board: async () => "note",
    statusMessage: () => "VB SIZE PEND"
  });

  const update = await collectAndRender(plugin);
  assert.equal(update.message.text.split("\n")[2], "VB SIZE PEND   ");
  assert.equal(update.message.characters?.[2].length, 15);
});


test("board preference defaults to auto and validates explicit values", () => {
  assert.equal(boardPreferenceFromEnv(undefined), "auto");
  assert.equal(boardPreferenceFromEnv(""), "auto");
  assert.equal(boardPreferenceFromEnv("note"), "note");
  assert.equal(boardPreferenceFromEnv("flagship"), "flagship");
  assert.equal(boardPreferenceFromEnv("auto"), "auto");
  assert.throws(() => boardPreferenceFromEnv("wide"), /VESTABOARD_BOARD/);
});

test("auto board resolver assumes Note then retries until detection succeeds", async () => {
  let calls = 0;
  const resolver = createVestaboardBoardResolver({
    preference: "auto",
    async detectBoard() {
      calls += 1;
      return calls === 1 ? undefined : "flagship";
    },
    logger: { warn() {} }
  });

  assert.equal(await resolver.resolve(), "note");
  assert.deepEqual(resolver.resolution(), { board: "note", source: "assumed" });
  assert.equal(await resolver.resolve(), "flagship");
  assert.deepEqual(resolver.resolution(), { board: "flagship", source: "confirmed" });
  assert.equal(await resolver.resolve(), "flagship");
  assert.equal(calls, 2);
});

test("explicit board resolver is confirmed and never detects", async () => {
  let calls = 0;
  const resolver = createVestaboardBoardResolver({
    preference: "note",
    async detectBoard() {
      calls += 1;
      return "flagship";
    }
  });

  assert.equal(await resolver.resolve(), "note");
  assert.deepEqual(resolver.resolution(), { board: "note", source: "confirmed" });
  assert.equal(calls, 0);
});

test("Vestaboard board detection infers dimensions from Cloud API layout", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const board = await detectVestaboardBoard({
    token: "cloud-token",
    cloudUrl: "https://cloud.example/",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return Response.json({
        currentMessage: {
          layout: JSON.stringify(Array.from({ length: 6 }, () => Array(22).fill(0)))
        }
      });
    }
  });

  assert.equal(board, "flagship");
  assert.equal(requests[0]?.url, "https://cloud.example/");
  assert.equal((requests[0]?.init.headers as Record<string, string>)["X-Vestaboard-Token"], "cloud-token");
});

test("Vestaboard board detection infers Note dimensions from Cloud API layout", async () => {
  const board = await detectVestaboardBoard({
    token: "cloud-token",
    cloudUrl: "https://cloud.example/",
    fetchImpl: async () => Response.json({
      currentMessage: {
        layout: JSON.stringify(Array.from({ length: 3 }, () => Array(15).fill(0)))
      }
    })
  });

  assert.equal(board, "note");
});

test("Vestaboard board detection returns undefined when no layout is available", async () => {
  const board = await detectVestaboardBoard({
    token: "cloud-token",
    cloudUrl: "https://cloud.example/",
    fetchImpl: async () => Response.json({ status: "error", message: "No message found for board" })
  });

  assert.equal(board, undefined);
});

test("Cloud Vestaboard board detection logs raw response only when detection fails", async () => {
  const messages: string[] = [];
  const board = await detectVestaboardBoard({
    token: "cloud-token",
    cloudUrl: "https://cloud.example/",
    fetchImpl: async () => Response.json({ status: "error", message: "No message found for board" }),
    logger: {
      info(message) {
        messages.push(message);
      }
    }
  });

  assert.equal(board, undefined);
  assert.deepEqual(messages, [
    "Vestaboard Cloud API raw response: {\"status\":\"error\",\"message\":\"No message found for board\"}"
  ]);
});

test("Cloud Vestaboard board detection does not log raw response when detection succeeds", async () => {
  const messages: string[] = [];
  const board = await detectVestaboardBoard({
    token: "cloud-token",
    cloudUrl: "https://cloud.example/",
    fetchImpl: async () => Response.json({
      currentMessage: {
        layout: Array.from({ length: 6 }, () => Array(22).fill(0))
      }
    }),
    logger: {
      info(message) {
        messages.push(message);
      }
    }
  });

  assert.equal(board, "flagship");
  assert.deepEqual(messages, []);
});

test("local Vestaboard board detection detects message layout without raw logging", async () => {
  const messages: string[] = [];
  const board = await detectLocalVestaboardBoard({
    localApiKey: "local-key",
    localUrl: "http://local.example/message",
    fetchImpl: async () => Response.json({ message: Array.from({ length: 3 }, () => Array(15).fill(0)) }),
    logger: {
      info(message) {
        messages.push(message);
      }
    }
  });

  assert.equal(board, "note");
  assert.deepEqual(messages, []);
});

test("local Vestaboard board detection logs raw response only when detection fails", async () => {
  const messages: string[] = [];
  const board = await detectLocalVestaboardBoard({
    localApiKey: "local-key",
    localUrl: "http://local.example/message",
    fetchImpl: async () => Response.json({ status: "ok", message: "No message found" }),
    logger: {
      info(message) {
        messages.push(message);
      }
    }
  });

  assert.equal(board, undefined);
  assert.equal(messages[0], "Vestaboard Local API raw response: {\"status\":\"ok\",\"message\":\"No message found\"}");
});

test("vestaboard client prefers local API when local key is configured", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = createVestaboardClient({
    dryRun: false,
    token: "cloud-token",
    localApiKey: "local-key",
    cloudUrl: "https://cloud.example/",
    localUrl: "http://local.example/message",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response("", { status: 200 });
    }
  });

  await client.send({ text: "ok", characters: [[1, 2, 3]] });

  assert.equal(requests[0]?.url, "http://local.example/message");
  assert.equal((requests[0]?.init.headers as Record<string, string>)["X-Vestaboard-Local-Api-Key"], "local-key");
  assert.equal(
    requests[0]?.init.body,
    "{\"characters\":[[1,2,3]],\"strategy\":\"row\",\"step_interval_ms\":2000,\"step_size\":1}"
  );
});

test("vestaboard client uses configured local message transitions", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = createVestaboardClient({
    dryRun: false,
    localApiKey: "local-key",
    localUrl: "http://local.example/message",
    localMessageTransition: {
      strategy: "diagonal",
      stepIntervalMs: 2500,
      stepSize: 3
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response("", { status: 200 });
    }
  });

  await client.send({ text: "ok", characters: [[1, 2, 3]] });

  assert.equal(
    requests[0]?.init.body,
    "{\"characters\":[[1,2,3]],\"strategy\":\"diagonal\",\"step_interval_ms\":2500,\"step_size\":3}"
  );
});

test("vestaboard client detects Flagship through local API when local key is configured", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = createVestaboardClient({
    dryRun: false,
    token: "cloud-token",
    localApiKey: "local-key",
    cloudUrl: "https://cloud.example/",
    localUrl: "http://local.example/message",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      if (init?.method === "GET") {
        return Response.json(Array.from({ length: 6 }, () => Array(22).fill(0)));
      }

      return new Response("", { status: 200 });
    }
  });

  const board = await client.detectBoard?.();
  await client.send({ text: "ok", characters: [[1, 2, 3]] });

  assert.equal(board, "flagship");
  assert.equal(requests[0]?.url, "http://local.example/message");
  assert.equal(requests[0]?.init.method, "GET");
  assert.equal((requests[0]?.init.headers as Record<string, string>)["X-Vestaboard-Local-Api-Key"], "local-key");
  assert.equal(requests[1]?.url, "http://local.example/message");
  assert.equal((requests[1]?.init.headers as Record<string, string>)["X-Vestaboard-Local-Api-Key"], "local-key");
  assert.equal(
    requests[1]?.init.body,
    "{\"characters\":[[1,2,3]],\"strategy\":\"row\",\"step_interval_ms\":2000,\"step_size\":1}"
  );
});

test("local message transition env parser falls back after invalid values", () => {
  const errors: string[] = [];
  const parsed = localMessageTransitionOptionsFromEnv({
    VESTABOARD_LOCAL_MESSAGE_STRATEGY: "spin",
    VESTABOARD_LOCAL_MESSAGE_STEP_INTERVAL_MS: "NaN",
    VESTABOARD_LOCAL_MESSAGE_STEP_SIZE: "0"
  }, {
    error(message) {
      errors.push(message);
    }
  });

  assert.equal(parsed.hasError, true);
  assert.deepEqual(parsed.options, {
    strategy: "row",
    stepIntervalMs: 2000,
    stepSize: 1
  });
  assert.deepEqual(errors, [
    "Invalid VESTABOARD_LOCAL_MESSAGE_STRATEGY 'spin'; using default 'row'.",
    "Invalid VESTABOARD_LOCAL_MESSAGE_STEP_INTERVAL_MS 'NaN'; using default '2000'.",
    "Invalid VESTABOARD_LOCAL_MESSAGE_STEP_SIZE '0'; using default '1'."
  ]);
});

test("local message transition env parser accepts configured values", () => {
  const parsed = localMessageTransitionOptionsFromEnv({
    VESTABOARD_LOCAL_MESSAGE_STRATEGY: "random",
    VESTABOARD_LOCAL_MESSAGE_STEP_INTERVAL_MS: "1500",
    VESTABOARD_LOCAL_MESSAGE_STEP_SIZE: "2"
  }, {
    error() {
      throw new Error("unexpected error");
    }
  });

  assert.equal(parsed.hasError, false);
  assert.deepEqual(parsed.options, {
    strategy: "random",
    stepIntervalMs: 1500,
    stepSize: 2
  });
});

test("vestaboard client detects Note through local API without cloud token", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = createVestaboardClient({
    dryRun: false,
    localApiKey: "local-key",
    localUrl: "http://local.example/message",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return Response.json(Array.from({ length: 3 }, () => Array(15).fill(0)));
    }
  });

  assert.equal(await client.detectBoard?.(), "note");
  assert.equal(requests[0]?.url, "http://local.example/message");
  assert.equal(requests[0]?.init.method, "GET");
  assert.equal((requests[0]?.init.headers as Record<string, string>)["X-Vestaboard-Local-Api-Key"], "local-key");
});

test("vestaboard client uses local detection in dry-run local mode", async () => {
  const client = createVestaboardClient({
    dryRun: true,
    localApiKey: "local-key",
    localUrl: "http://local.example/message",
    fetchImpl: async () => Response.json(Array.from({ length: 6 }, () => Array(22).fill(0))),
    logger: { info() {} }
  });

  assert.equal(await client.detectBoard?.(), "flagship");
});

test("vestaboard client falls back to cloud API when local key is absent", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = createVestaboardClient({
    dryRun: false,
    token: "cloud-token",
    cloudUrl: "https://cloud.example/",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response("", { status: 200 });
    }
  });

  await client.send({ text: "ok" });

  assert.equal(requests[0]?.url, "https://cloud.example/");
  assert.equal((requests[0]?.init.headers as Record<string, string>)["X-Vestaboard-Token"], "cloud-token");
  assert.equal(requests[0]?.init.body, "{\"text\":\"ok\"}");
});

test("vestaboard client detects board through cloud API when local key is absent", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const client = createVestaboardClient({
    dryRun: false,
    token: "cloud-token",
    cloudUrl: "https://cloud.example/",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return Response.json({ currentMessage: { layout: Array.from({ length: 6 }, () => Array(22).fill(0)) } });
    }
  });

  assert.equal(await client.detectBoard?.(), "flagship");
  assert.equal(requests[0]?.url, "https://cloud.example/");
  assert.equal(requests[0]?.init.method, "GET");
  assert.equal((requests[0]?.init.headers as Record<string, string>)["X-Vestaboard-Token"], "cloud-token");
});

test("error message is encodable for Vestaboard Note", () => {
  const message = formatError(new Error("Codex app-server timed out after 10000ms."));

  assert.equal(message.text.split("\n")[0], "CODEX QUOTA ERR");
  assert.equal(message.characters?.length, 3);
  assert.equal(message.characters?.every((row) => row.length === 15), true);
});


function model(name: string, reasoningEfforts: string[]) {
  return {
    id: name,
    model: name,
    supportedReasoningEfforts: reasoningEfforts.map((reasoningEffort) => ({ reasoningEffort }))
  };
}

type LegacyQuotaSnapshot = {
  fiveHour?: Omit<QuotaWindow, "id">;
  weekly?: Omit<QuotaWindow, "id">;
};

type TestQuotaSnapshot = QuotaSnapshot | LegacyQuotaSnapshot;
type FormatOptions = NonNullable<Parameters<typeof formatQuotaWindows>[1]>;
type LegacyFormatOptions = Omit<FormatOptions, "resetVisibility" | "staleWindowIds"> & {
  resetVisibility?: FormatOptions["resetVisibility"] | { fiveHour: boolean; weekly: boolean };
  staleRows?: Array<"5H" | "WK">;
};

function formatQuota(snapshot: TestQuotaSnapshot, options: LegacyFormatOptions = {}) {
  const normalized = normalizeQuotaSnapshot(snapshot);
  const { resetVisibility, staleRows, ...currentOptions } = options;
  const translatedResetVisibility = resetVisibility && "fiveHour" in resetVisibility
    ? { primary: resetVisibility.fiveHour, secondary: resetVisibility.weekly }
    : resetVisibility;

  return formatQuotaWindows(normalized, {
    ...currentOptions,
    staleWindowIds: staleRows?.map((row) => row === "5H" ? "primary" : "secondary"),
    resetVisibility: translatedResetVisibility
  });
}

type TestCodexQuotaPlugin = CodexQuotaPlugin & {
  testBoard: () => Promise<"note" | "flagship">;
  testNow: () => Date;
};
type TestCodexQuotaPluginOptions = ConstructorParameters<typeof CodexQuotaPlugin>[1] & {
  board?: () => Promise<"note" | "flagship">;
};

async function collectAndRender(plugin: TestCodexQuotaPlugin) {
  await plugin.collect();
  const now = plugin.testNow();
  const state = plugin.getDisplayState(now);
  const board = await plugin.testBoard();
  if (!state.snapshot) {
    return {
      message: formatError(
        new Error(state.statusMessage ?? "Codex quota has not been collected yet."),
        { board, statusMessage: state.statusMessage }
      )
    };
  }

  return {
    message: formatQuotaWindows(state.snapshot, {
      board,
      timeZone: state.timeZone,
      now,
      statusMessage: state.statusMessage,
      staleWindowIds: state.staleWindowIds,
      showPacing: state.showPacing,
      resetVisibility: state.resetVisibility
    })
  };
}

function testCodexQuotaPlugin(
  readQuota: (options?: { now?: Date }) => Promise<{
    snapshot: TestQuotaSnapshot;
    statusMessage?: string;
    sidecarError?: unknown;
    rateLimitResetCreditsAvailableCount?: number;
  }>,
  options: TestCodexQuotaPluginOptions = {}
): TestCodexQuotaPlugin {
  const board = typeof options.board === "function"
    ? options.board as () => Promise<"note" | "flagship">
    : async () => "note" as const;
  const now = typeof options.now === "function"
    ? options.now as () => Date
    : () => new Date();
  const {
    board: _board,
    ...pluginOptions
  } = options;
  const plugin = new CodexQuotaPlugin(async (pollOptions) => {
    const result = await readQuota(pollOptions);
    return {
      ...result,
      snapshot: normalizeQuotaSnapshot(result.snapshot)
    };
  }, pluginOptions as ConstructorParameters<typeof CodexQuotaPlugin>[1]);
  return Object.assign(plugin, { testBoard: board, testNow: now });
}

function normalizeQuotaSnapshot(snapshot: TestQuotaSnapshot): QuotaSnapshot {
  if ("windows" in snapshot) {
    return snapshot;
  }

  return {
    windows: [
      snapshot.fiveHour ? { id: "primary", ...snapshot.fiveHour } : undefined,
      snapshot.weekly ? { id: "secondary", ...snapshot.weekly } : undefined
    ].filter((window): window is QuotaWindow => window !== undefined)
  };
}

function quotaSnapshot({ fiveHour, weekly }: { fiveHour?: number; weekly?: number }): QuotaSnapshot {
  return normalizeQuotaSnapshot({
    fiveHour: fiveHour === undefined
      ? undefined
      : { remainingRatio: fiveHour, resetAt: new Date("2026-06-19T02:44:00-07:00"), durationMins: 300 },
    weekly: weekly === undefined
      ? undefined
      : { remainingRatio: weekly, resetAt: new Date("2026-06-24T14:19:00-07:00"), durationMins: 10_080 }
  });
}

function windowForDuration(snapshot: QuotaSnapshot, durationMins: number): QuotaWindow | undefined {
  return snapshot.windows.find((window) => window.durationMins === durationMins);
}

function quotaPollResult(snapshot: TestQuotaSnapshot) {
  return { snapshot: normalizeQuotaSnapshot(snapshot) };
}

function quotaClient(
  overrides: Pick<CodexAppServerClient, "readAccount" | "readRateLimits">
): CodexAppServerClient {
  return {
    ...overrides,
    async readModels() {
      throw new Error("unexpected readModels");
    },
    async startThread() {
      throw new Error("unexpected startThread");
    },
    async startTurn() {
      throw new Error("unexpected startTurn");
    },
    async waitForTurnCompletion() {
      throw new Error("unexpected waitForTurnCompletion");
    }
  };
}

function expiredTokenError(): CodexAppServerError {
  return new CodexAppServerError({
    code: -32603,
    message: "failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized; body={\"code\":\"token_expired\"}"
  });
}

function rateLimitsResult(usedPercent: number): RateLimitsResult {
  return {
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent, windowDurationMins: 300 }
    }
  };
}
