import type { HAConfig, HAEntity, HAStatus } from "./contracts/homeAssistant.js";

export type { HAConfig, HAEntity, HAStatus } from "./contracts/homeAssistant.js";

export interface HomeAssistantSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
}

export interface HomeAssistantClientOptions {
  url: string;
  token: string;
  socketFactory?: (url: string) => HomeAssistantSocket;
  changed?: () => void;
  timers?: HomeAssistantTimers;
}

export interface HomeAssistantTimers {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
}

const DEFAULT_TIMERS: HomeAssistantTimers = {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
};

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 65_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export class HomeAssistantClient {
  private readonly url: string;
  private readonly token: string;
  private readonly socketFactory: (url: string) => HomeAssistantSocket;
  private readonly changed?: () => void;
  private readonly listeners = new Set<() => void>();
  private readonly timers: HomeAssistantTimers;
  private socket: HomeAssistantSocket | undefined;
  private entities = new Map<string, HAEntity>();
  private connected = false;
  private error: string | undefined;
  private started = false;
  private stopped = false;
  private ready = false;
  private initialRequestId: number | undefined;
  private subscribeRequestId: number | undefined;
  private nextMessageId = 1;
  private bufferedEvents: HAEntity[] = [];
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private lastPongAt = 0;
  private readyWaiters: Array<{ resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];

  constructor(options: HomeAssistantClientOptions) {
    this.url = options.url;
    this.token = options.token;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory(options.url);
    this.changed = options.changed;
    this.timers = options.timers ?? DEFAULT_TIMERS;
  }

  start(): void {
    if (this.started && !this.stopped) return;
    this.started = true;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    this.ready = false;
    this.connected = false;
    this.clearReconnectTimer();
    this.clearPingTimer();
    this.detachSocket();
    for (const waiter of this.readyWaiters.splice(0)) {
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(new Error("Home Assistant connection stopped."));
    }
  }

  states(): HAEntity[] {
    return [...this.entities.values()].map(cloneEntity);
  }

  status(): HAStatus {
    return {
      connected: this.connected,
      ...(this.error ? { error: this.error } : {})
    };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitUntilReady(timeoutMs = 10_000): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        const index = this.readyWaiters.findIndex((waiter) => waiter.timer === timer);
        if (index >= 0) this.readyWaiters.splice(index, 1);
        reject(new Error(this.error ?? "Home Assistant connection timed out."));
      }, timeoutMs);
      this.readyWaiters.push({ resolve, reject, timer });
      if (!this.started) this.start();
    });
  }

  private connect(): void {
    if (this.stopped) return;
    this.clearReconnectTimer();
    this.ready = false;
    this.connected = false;
    this.bufferedEvents = [];
    this.initialRequestId = undefined;
    this.subscribeRequestId = undefined;
    try {
      const socket = this.socketFactory(this.url);
      this.socket = socket;
      this.handshakeTimer = this.timers.setTimeout(() => {
        this.fail("Home Assistant WebSocket handshake timed out.");
        this.closeForRecovery();
      }, HANDSHAKE_TIMEOUT_MS);
      socket.onopen = () => undefined;
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onerror = () => {
        this.fail("Home Assistant WebSocket error.");
        this.closeForRecovery();
      };
      socket.onclose = () => this.handleClose();
    } catch {
      this.fail("Unable to connect to Home Assistant.");
      this.scheduleReconnect();
    }
  }

  private handleMessage(raw: unknown): void {
    let message: Record<string, unknown>;
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid message");
      message = parsed as Record<string, unknown>;
    } catch {
      this.fail("Home Assistant sent an invalid message.");
      this.closeForRecovery();
      return;
    }

    const type = typeof message.type === "string" ? message.type : "";
    if (type === "auth_required") {
      this.send({ type: "auth", access_token: this.token });
      return;
    }
    if (type === "auth_ok") {
      this.sendSubscriptionRequests();
      this.startPingHealth();
      return;
    }
    if (type === "auth_invalid") {
      this.fail("Home Assistant authentication failed.");
      this.detachSocket();
      return;
    }
    if (type === "pong") {
      this.lastPongAt = Date.now();
      return;
    }
    if (type === "event") {
      const event = message.event && typeof message.event === "object" ? message.event : message;
      this.handleStateChanged(event as Record<string, unknown>);
      return;
    }
    if (type === "result" && typeof message.id === "number") {
      this.handleResult(message);
    }
  }

  private sendSubscriptionRequests(): void {
    this.subscribeRequestId = this.nextMessageId++;
    this.send({ id: this.subscribeRequestId, type: "subscribe_events", event_type: "state_changed" });
  }

  private handleResult(message: Record<string, unknown>): void {
    if (message.success !== true) {
      this.fail("Home Assistant request failed.");
      this.closeForRecovery();
      return;
    }
    if (message.id === this.subscribeRequestId) {
      this.initialRequestId = this.nextMessageId++;
      this.send({ id: this.initialRequestId, type: "get_states" });
      return;
    }
    if (message.id !== this.initialRequestId) return;
    this.clearHandshakeTimer();
    if (!Array.isArray(message.result)) {
      this.fail("Home Assistant sent invalid state data.");
      this.closeForRecovery();
      return;
    }
    const result = message.result
      .map(normalizeEntity)
      .filter((entity) => entity.entity_id.length > 0);
    this.entities = new Map(result.map((entity) => [entity.entity_id, entity]));
    for (const entity of this.bufferedEvents) {
      const initial = this.entities.get(entity.entity_id);
      if (!initial || isNewer(entity, initial)) this.entities.set(entity.entity_id, entity);
    }
    this.bufferedEvents = [];
    this.ready = true;
    this.connected = true;
    this.error = undefined;
    this.reconnectAttempt = 0;
    this.resolveReadyWaiters();
    this.notifyChanged();
  }

  private handleStateChanged(event: Record<string, unknown>): void {
    const data = event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {};
    const candidate = data.new_state && typeof data.new_state === "object"
      ? data.new_state as Record<string, unknown>
      : {
          entity_id: data.entity_id,
          state: "unknown",
          attributes: {},
          last_updated: typeof event.time_fired === "string" ? event.time_fired : undefined
        };
    const entity = normalizeEntity(candidate);
    if (!entity.entity_id) return;
    if (!this.ready) {
      this.bufferedEvents.push(entity);
      return;
    }
    this.entities.set(entity.entity_id, entity);
    this.notifyChanged();
  }

  private send(message: Record<string, unknown>): void {
    try {
      this.socket?.send(JSON.stringify(message));
    } catch {
      this.fail("Home Assistant WebSocket send failed.");
      this.closeForRecovery();
    }
  }

  private startPingHealth(): void {
    this.clearPingTimer();
    this.lastPongAt = Date.now();
    this.pingTimer = this.timers.setInterval(() => {
      if (Date.now() - this.lastPongAt > PONG_TIMEOUT_MS) {
        this.fail("Home Assistant WebSocket ping timed out.");
        this.closeForRecovery();
        return;
      }
      this.send({ id: this.nextMessageId++, type: "ping" });
    }, PING_INTERVAL_MS);
  }

  private closeForRecovery(): void {
    this.detachSocket();
    this.scheduleReconnect();
  }

  private handleClose(): void {
    this.fail("Home Assistant connection closed.");
    this.detachSocket();
    this.ready = false;
    this.connected = false;
    if (!this.stopped) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * (2 ** this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private detachSocket(): void {
    this.clearHandshakeTimer();
    this.clearPingTimer();
    if (!this.socket) return;
    this.socket.onopen = null;
    this.socket.onmessage = null;
    this.socket.onerror = null;
    this.socket.onclose = null;
    try { this.socket.close(); } catch { /* connection is already gone */ }
    this.socket = undefined;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private clearPingTimer(): void {
    if (this.pingTimer) {
      this.timers.clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      this.timers.clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private resolveReadyWaiters(): void {
    for (const waiter of this.readyWaiters.splice(0)) {
      this.timers.clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private fail(message: string): void {
    const changed = this.error !== message || this.connected;
    this.error = message;
    this.connected = false;
    this.ready = false;
    this.rejectReadyWaiters(new Error(message));
    if (changed) this.notifyChanged();
  }

  private rejectReadyWaiters(error: Error): void {
    for (const waiter of this.readyWaiters.splice(0)) {
      this.timers.clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private notifyChanged(): void {
    try { this.changed?.(); } catch { /* a subscriber must not break the socket */ }
    for (const listener of this.listeners) {
      try { listener(); } catch { /* a subscriber must not break the socket */ }
    }
  }
}

export function createHomeAssistantClient(options: HomeAssistantClientOptions): HomeAssistantClient {
  return new HomeAssistantClient(options);
}

export async function testHAConnection(url: string, token: string): Promise<HAStatus> {
  const client = createHomeAssistantClient({ url, token });
  try {
    await client.waitUntilReady();
    return client.status();
  } catch (error) {
    return { connected: false, error: error instanceof Error ? error.message : "Home Assistant connection failed." };
  } finally {
    client.stop();
  }
}

function normalizeEntity(value: unknown): HAEntity {
  const entity = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const attributes = entity.attributes && typeof entity.attributes === "object" && !Array.isArray(entity.attributes)
    ? entity.attributes as Record<string, unknown>
    : {};
  return {
    entity_id: typeof entity.entity_id === "string" ? entity.entity_id : "",
    state: typeof entity.state === "string" && entity.state.length > 0 ? entity.state : "unknown",
    attributes: { ...attributes },
    ...(typeof entity.last_updated === "string" ? { last_updated: entity.last_updated } : {})
  };
}

function cloneEntity(entity: HAEntity): HAEntity {
  return { ...entity, attributes: { ...entity.attributes } };
}

function isNewer(candidate: HAEntity, current: HAEntity): boolean {
  if (!candidate.last_updated || !current.last_updated) return false;
  const candidateTime = Date.parse(candidate.last_updated);
  const currentTime = Date.parse(current.last_updated);
  return Number.isFinite(candidateTime) && Number.isFinite(currentTime) && candidateTime > currentTime;
}

export function homeAssistantWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  else if (parsed.protocol === "https:") parsed.protocol = "wss:";
  else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new Error("Home Assistant URL must use HTTP(S).");
  parsed.search = "";
  parsed.hash = "";
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path.endsWith("/api/websocket")
    ? path
    : `${path.endsWith("/api") ? path : `${path}/api`}/websocket`;
  return parsed.toString();
}

function defaultSocketFactory(url: string): (url: string) => HomeAssistantSocket {
  const socketUrl = homeAssistantWebSocketUrl(url);
  return () => new WebSocket(socketUrl) as unknown as HomeAssistantSocket;
}
