import test from "node:test";
import assert from "node:assert/strict";
import { composePauseOverlay } from "../src/pauseOverlay.js";
import { defaultPauseOverlay, PauseOverlaySchema } from "../src/contracts/pauseOverlay.js";

const note = { text: "", characters: Array.from({ length: 3 }, () => Array(15).fill(23)) };
const flagship = { text: "", characters: Array.from({ length: 6 }, () => Array(22).fill(23)) };

test("default pause overlay draws separate centered icons for both board sizes", () => {
  const overlay = defaultPauseOverlay();
  assert.equal(overlay.note.length, 3);
  assert.equal(overlay.note[0]?.length, 15);
  assert.equal(overlay.flagship.length, 6);
  assert.equal(overlay.flagship[0]?.length, 22);
  assert.ok(overlay.note.flat().some((cell) => cell === 69));
  assert.ok(overlay.flagship.flat().some((cell) => cell === 69));
  assert.ok(overlay.note.flat().some((cell) => cell === null));
});

test("pause overlay composes transparent, opaque blank, and character cells", () => {
  const overlay = defaultPauseOverlay();
  overlay.note[0]![0] = null;
  overlay.note[0]![1] = 0;
  overlay.note[0]![2] = 1;
  const result = composePauseOverlay(note, overlay, "note");
  assert.equal(result.characters?.[0]?.[0], 23);
  assert.equal(result.characters?.[0]?.[1], 0);
  assert.equal(result.characters?.[0]?.[2], 1);
  assert.equal(result.characters?.[0]?.[5], 69);
});

test("pause overlay validation rejects invalid dimensions and code 71", () => {
  const overlay = defaultPauseOverlay();
  assert.deepEqual(PauseOverlaySchema.parse(overlay), overlay);
  assert.throws(() => PauseOverlaySchema.parse({ ...overlay, note: [[null]] }), /note canvas/);
  const invalid = structuredClone(overlay);
  invalid.flagship[0]![0] = 71;
  assert.throws(() => PauseOverlaySchema.parse(invalid), /valid Vestaboard character code/);
});

test("flagship overlay composes with the flagship matrix", () => {
  const overlay = defaultPauseOverlay();
  const result = composePauseOverlay(flagship, overlay, "flagship");
  assert.equal(result.characters?.length, 6);
  assert.equal(result.characters?.[1]?.[8], 69);
  assert.equal(result.characters?.[0]?.[8], 23);
});
