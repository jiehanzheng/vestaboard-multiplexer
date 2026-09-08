import assert from "node:assert/strict";
import test from "node:test";

import {
  BLACK,
  BLANK,
  BLUE,
  characterDisplay,
  characterOption,
  charCode,
  encode,
  GREEN,
  HEART,
  isValidCharacterCode,
  ORANGE,
  RED,
  VIOLET,
  WHITE,
  YELLOW
} from "../src/vestaboardCharacters.js";

test("encodes Vestaboard letters, digits, punctuation, and colors", () => {
  assert.deepEqual(encode("A 10?!♥"), [1, 0, 27, 36, 60, 37, HEART]);
  assert.equal(charCode("a"), 1);
  assert.deepEqual(
    [RED, ORANGE, YELLOW, GREEN, BLUE, VIOLET, WHITE, BLACK].map(isValidCharacterCode),
    [true, true, true, true, true, true, true, true]
  );
  assert.equal(isValidCharacterCode(43), false);
});

test("rejects unsupported characters", () => {
  assert.throws(() => charCode("é"), /Unsupported Vestaboard character/);
});

test("catalogs every local code and keeps board-specific code 62 display data", () => {
  assert.deepEqual(characterOption(62), {
    code: 62,
    name: "Degree / Heart",
    display: { note: "♥", flagship: "°" }
  });
  assert.equal(characterDisplay(62, "note"), "♥");
  assert.equal(characterDisplay(62, "flagship"), "°");
  for (const code of [0, ...Array.from({ length: 26 }, (_, index) => index + 1), ...Array.from({ length: 10 }, (_, index) => index + 27), 37, 38, 39, 40, 41, 42, 44, 46, 47, 48, 49, 50, 52, 53, 54, 55, 56, 59, 60, 62, 63, 64, 65, 66, 67, 68, 69, 70]) {
    assert.equal(isValidCharacterCode(code), true, `expected ${code} to be valid`);
  }
  for (const code of [43, 45, 51, 57, 58, 61, 71]) assert.equal(isValidCharacterCode(code), false);
});
