import assert from "node:assert/strict";
import test from "node:test";

import {
  BLACK,
  BLANK,
  BLUE,
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
