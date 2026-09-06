import assert from "node:assert/strict";
import test from "node:test";

import {
  HomeAssistantClient,
  haPauseBinding,
  homeAssistantWebSocketUrl,
  readHAPause,
  type HomeAssistantSocket
} from "../src/homeAssistant.js";

class FakeSocket implements HomeAssistantSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: Record<string, unknown>[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    this.closed = true;
  }

  receive(message: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

test("authenticates, subscribes before get_states, and keeps initial snapshot ahead of old events", async () => {
  const socket = new FakeSocket();
  let changed = 0;
  const client = new HomeAssistantClient({
    url: "ws://ha.local/api/websocket",
    token: "secret",
    socketFactory: () => socket,
    changed: () => { changed += 1; }
  });
  try {
    client.start();
    socket.receive({ type: "auth_required" });
    assert.deepEqual(socket.sent[0], { type: "auth", access_token: "secret" });
    socket.receive({ type: "auth_ok", ha_version: "2026.1" });
    assert.equal(socket.sent[1]?.type, "subscribe_events");
    const subscribeId = socket.sent[1]?.id as number;
    socket.receive({ id: subscribeId, type: "result", success: true, result: null });
    assert.equal(socket.sent[2]?.type, "get_states");
    const statesId = socket.sent[2]?.id as number;
    socket.receive({
    type: "event",
    data: {
      entity_id: "sensor.tank",
      new_state: { entity_id: "sensor.tank", state: "40", attributes: {}, last_updated: "2025-01-01T00:00:00Z" }
    }
    });
    socket.receive({
    id: statesId,
    type: "result",
    success: true,
    result: [{ entity_id: "sensor.tank", state: "50", attributes: { unit: "F" }, last_updated: "2025-01-02T00:00:00Z" }]
    });
    assert.equal(client.status().connected, true);
    assert.equal(client.states()[0]?.state, "50");

    socket.receive({
    type: "event",
    data: {
      entity_id: "sensor.tank",
      new_state: { entity_id: "sensor.tank", state: "55", attributes: {}, last_updated: "2025-01-03T00:00:00Z" }
    }
    });
    assert.equal(client.states()[0]?.state, "55");
    assert.equal(changed, 2);
    assert.equal(socket.closed, false);
  } finally {
    client.stop();
  }
  assert.equal(socket.closed, true);
});

test("retains unknown entities and redacts connection details from errors", () => {
  const socket = new FakeSocket();
  const client = new HomeAssistantClient({ url: "ws://ha.local/secret", token: "top-secret", socketFactory: () => socket });
  client.start();
  socket.receive({ type: "auth_invalid", message: "token top-secret at ws://ha.local/secret" });
  const status = client.status();
  assert.equal(status.connected, false);
  assert.match(status.error ?? "", /authentication failed/i);
  assert.doesNotMatch(status.error ?? "", /top-secret|ha\.local/);
  client.stop();
});

test("rejects readiness immediately on authentication failure and cleans up the socket", async () => {
  const socket = new FakeSocket();
  let changed = 0;
  const client = new HomeAssistantClient({ url: "ws://ha.local", token: "secret", socketFactory: () => socket, changed: () => { changed += 1; } });
  const ready = client.waitUntilReady(1000);
  socket.receive({ type: "auth_required" });
  socket.receive({ type: "auth_invalid", message: "sensitive details" });
  await assert.rejects(ready, /authentication failed/i);
  assert.equal(socket.closed, true);
  assert.equal(changed, 1);
  client.stop();
});

test("reports a remote close and rejects readiness waiters", async () => {
  const socket = new FakeSocket();
  let changed = 0;
  const client = new HomeAssistantClient({ socketFactory: () => socket, url: "http://ha.local:8123", token: "secret", changed: () => { changed += 1; } });
  const ready = client.waitUntilReady(1000);
  socket.onclose?.();
  await assert.rejects(ready, /connection closed/i);
  assert.equal(client.status().connected, false);
  assert.equal(changed, 1);
  client.stop();
});

test("maps only exact configured Home Assistant pause states", () => {
  const config = { url: "ws://ha.local", pause: { entityId: "input_boolean.pause", pauseValue: "on", resumeValue: "off" } };
  assert.equal(haPauseBinding(config), JSON.stringify([config.url, "input_boolean.pause", "on", "off"]));
  assert.equal(haPauseBinding({ ...config, url: "" }), JSON.stringify(["", "input_boolean.pause", "on", "off"]));
  assert.equal(readHAPause(config, [{ entity_id: "input_boolean.pause", state: "on", attributes: {} }]), true);
  assert.equal(readHAPause(config, [{ entity_id: "input_boolean.pause", state: "off", attributes: {} }]), false);
  assert.equal(readHAPause(config, [{ entity_id: "input_boolean.pause", state: "unknown", attributes: {} }]), undefined);
  assert.equal(readHAPause(config, []), undefined);
  assert.equal(readHAPause({ ...config, pause: null }, []), undefined);
});

test("waitUntilReady resolves after the initial state result", async () => {
  const socket = new FakeSocket();
  const client = new HomeAssistantClient({ url: "ws://ha.local", token: "secret", socketFactory: () => socket });
  const ready = client.waitUntilReady(1000);
  socket.receive({ type: "auth_required" });
  socket.receive({ type: "auth_ok" });
  const subscribeId = socket.sent.find((message) => message.type === "subscribe_events")?.id as number;
  socket.receive({ id: subscribeId, type: "result", success: true, result: null });
  const statesId = socket.sent.find((message) => message.type === "get_states")?.id as number;
  socket.receive({ id: statesId, type: "result", success: true, result: [] });
  await ready;
  client.stop();
});

test("normalizes Home Assistant HTTP URLs to one WebSocket API endpoint", () => {
  assert.equal(homeAssistantWebSocketUrl("http://ha.local:8123"), "ws://ha.local:8123/api/websocket");
  assert.equal(homeAssistantWebSocketUrl("https://ha.local/api/websocket/"), "wss://ha.local/api/websocket");
  assert.equal(homeAssistantWebSocketUrl("https://ha.local/api"), "wss://ha.local/api/websocket");
});
