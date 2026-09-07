import assert from "node:assert/strict";
import test from "node:test";
import { LogBuffer } from "../src/logger.js";

test("log buffer redacts console and memory, truncates messages, and keeps latest 200 entries", () => {
  const output: string[] = [];
  const logger = new LogBuffer({
    info: (message) => output.push(String(message)),
    warn: (message) => output.push(String(message)),
    error: (message) => output.push(String(message))
  }, () => new Date("2026-09-06T12:00:00Z"));
  logger.setSecrets(["server-token"]);
  for (let index = 0; index < 201; index += 1) logger.child("water").warn(`entry ${index} server-token ${"x".repeat(3000)}`);

  const snapshot = logger.snapshot();
  assert.equal(snapshot.entries.length, 200);
  assert.equal(snapshot.entries[0]?.message.startsWith("entry 1 "), true);
  assert.equal(snapshot.entries.at(-1)?.message.includes("server-token"), false);
  assert.equal(snapshot.entries.at(-1)?.message.length, 2048);
  assert.equal(output.at(-1)?.includes("server-token"), false);
  assert.match(output.at(-1) ?? "", /2026-09-06T12:00:00\.000Z warn \[water\]/);
});

test("log messages are capped at 2KB of UTF-8 data", () => {
  const logger = new LogBuffer({ info() {}, warn() {}, error() {} });
  logger.child("test").info("界".repeat(60_000));
  const message = logger.snapshot().entries[0]!.message;
  assert.ok(new TextEncoder().encode(message).byteLength <= 2048);
});
