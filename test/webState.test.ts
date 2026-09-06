/// <reference types="node" />
import assert from "node:assert/strict";
import test from "node:test";
import { reconcileSave } from "../web/src/draftState.js";

test("save acknowledgement advances the baseline without overwriting a newer draft", () => {
  const result = reconcileSave({
    acknowledgement: { value: "saved", layout: [{ elementId: "one", startRow: 0 }] },
    currentDraftConfig: { value: "newer", layout: [{ elementId: "two", startRow: 1 }] },
    submittedRevision: 3,
    currentRevision: 4
  });

  assert.deepEqual(result.draftConfig, { value: "newer", layout: [{ elementId: "two", startRow: 1 }] });
});

test("save acknowledgement normalizes the draft when no newer edit exists", () => {
  const result = reconcileSave({
    acknowledgement: { value: "server-normalized" },
    currentDraftConfig: { value: "submitted" },
    submittedRevision: 7,
    currentRevision: 7
  });
  assert.deepEqual(result.draftConfig, { value: "server-normalized" });
});

test("a post-submit credential edit stays in the current draft after a redacted acknowledgement", () => {
  const result = reconcileSave({
    acknowledgement: { transport: {}, ha: {} },
    currentDraftConfig: { transport: { token: "entered-after-submit" }, ha: {} },
    submittedRevision: 3,
    currentRevision: 4
  });
  assert.equal(result.draftConfig.transport.token, "entered-after-submit");
});
