import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { CodexLogin } from "../src/codexLogin.js";
import { withCodexAppServer, type CodexLoginClient } from "../src/plugins/codexQuota/appServer.js";

test("device login publishes the code, consumes completion, and redacts failures", async () => {
  let notify: ((method: string, params: unknown) => void) | undefined;
  const run = (async (operation, options) => {
    notify = options?.onNotification;
    return operation({ startDeviceLogin: async () => ({ loginId: "id", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABC-DEF" }) } as CodexLoginClient);
  }) as typeof withCodexAppServer;
  const login = new CodexLogin(() => {}, run);
  login.start();
  await setImmediate();
  assert.equal(login.status().userCode, "ABC-DEF");
  assert.equal(login.status().pending, true);
  notify!("account/login/completed", { success: true });
  await setImmediate();
  assert.equal(login.status().account, "Connected");
  assert.equal(login.status().pending, false);
  await login.stop();

  const failed = new CodexLogin(() => {}, (async () => { throw new Error("secret-token"); }) as typeof withCodexAppServer);
  failed.start();
  await setImmediate();
  assert.ok(failed.status().error);
  assert.doesNotMatch(JSON.stringify(failed.status()), /secret-token/);
});

test("cancelling login owns and settles the active operation", async () => {
  let aborted = false;
  const run = (async (_operation, options) => new Promise((_, reject) => {
    options?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
  })) as typeof withCodexAppServer;
  const login = new CodexLogin(() => {}, run);
  login.start();
  await login.cancel();
  assert.equal(aborted, true);
  assert.deepEqual(login.status(), { pending: false });
});
