import type { HAEntitiesRequest, HAEntitiesResponse, HAStatus } from "./contracts/homeAssistant.js";
import {
  createHomeAssistantClient,
  type HomeAssistantClient,
  type HomeAssistantClientOptions
} from "./homeAssistant.js";
import type { HAEntity } from "./contracts/homeAssistant.js";

export interface HomeAssistantConnectionConfig {
  url: string;
  token?: string;
}

export interface HomeAssistantSnapshot {
  source: string;
  entities: readonly HAEntity[];
  connected: boolean;
  error?: string;
}

export interface HomeAssistantServiceOptions {
  createClient?: (options: HomeAssistantClientOptions) => HomeAssistantClient;
  changed?: () => void;
}

export type HomeAssistantInspection = HAStatus | HAEntitiesResponse;
export type HomeAssistantSnapshotListener = (snapshot: HomeAssistantSnapshot) => void;

export interface HomeAssistantServiceLike {
  configure(config: HomeAssistantConnectionConfig): void;
  snapshot(): HomeAssistantSnapshot;
  subscribe(callback: HomeAssistantSnapshotListener): () => void;
  start(): void;
  collectInitial(timeoutMs?: number): Promise<void>;
  inspect(action: "test" | "entities", input?: HAEntitiesRequest): Promise<HomeAssistantInspection>;
  stop(): Promise<void>;
}

interface ActiveConnection {
  key: string;
  client: HomeAssistantClient;
}

/** Owns the one live HA connection and short-lived clients used by settings checks. */
export class HomeAssistantService implements HomeAssistantServiceLike {
  private readonly createClient: (options: HomeAssistantClientOptions) => HomeAssistantClient;
  private readonly changed?: () => void;
  private readonly listeners = new Set<HomeAssistantSnapshotListener>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly temporaryClients = new Set<HomeAssistantClient>();
  private config: HomeAssistantConnectionConfig = { url: "" };
  private active: ActiveConnection | undefined;
  private started = false;
  private stopped = false;

  constructor(options: HomeAssistantServiceOptions = {}) {
    this.createClient = options.createClient ?? createHomeAssistantClient;
    this.changed = options.changed;
  }

  configure(config: HomeAssistantConnectionConfig): void {
    const next = { url: config.url, ...(config.token !== undefined ? { token: config.token } : {}) };
    const nextKey = connectionKey(next);
    this.config = next;
    if (this.active?.key === nextKey) {
      this.notify();
      return;
    }
    const previous = this.active;
    this.active = undefined;
    if (previous) this.track(this.stopClient(previous.client));
    if (this.started) this.start();
    this.notify();
  }

  snapshot(): HomeAssistantSnapshot {
    const status = this.active?.client.status();
    return {
      source: this.config.url,
      entities: this.active ? this.active.client.states().map(cloneEntity) : [],
      connected: status?.connected ?? false,
      ...(status?.error ? { error: status.error } : {})
    };
  }

  subscribe(callback: HomeAssistantSnapshotListener): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  start(): void {
    if (this.stopped) return;
    this.started = true;
    const active = this.ensureActive();
    active?.client.start();
    this.notify();
  }

  async collectInitial(timeoutMs = 10_000): Promise<void> {
    if (this.stopped) throw new Error("Home Assistant service is stopped.");
    this.start();
    const active = this.active;
    if (!active) throw new Error("Home Assistant URL is not configured.");
    return this.track(active.client.waitUntilReady(timeoutMs));
  }

  async inspect(action: "test" | "entities", input: HAEntitiesRequest = {}): Promise<HomeAssistantInspection> {
    if (this.stopped) {
      const error = "Home Assistant service is stopped.";
      if (action === "test") return { connected: false, error };
      throw new Error(error);
    }
    const requested = {
      url: input.url ?? this.config.url,
      token: input.token ?? this.config.token ?? ""
    };
    if (!requested.url) {
      const error = "Home Assistant URL is not configured.";
      if (action === "test") return { connected: false, error };
      throw new Error(error);
    }

    const sameAsSaved = requested.url === this.config.url && requested.token === (this.config.token ?? "");
    if (sameAsSaved) {
      try {
        await this.collectInitial();
        const client = this.active?.client;
        if (!client) throw new Error("Home Assistant URL is not configured.");
        return action === "test"
          ? client.status()
          : { entities: client.states().map(cloneEntity) };
      } catch (error) {
        const safe = safeError(error, requested.url, requested.token);
        if (action === "test") return { connected: false, error: safe };
        throw new Error(safe);
      }
    }

    return this.track(this.inspectTemporary(action, requested.url, requested.token));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    const active = this.active;
    this.active = undefined;
    const clients = [...this.temporaryClients];
    if (active) clients.push(active.client);
    await Promise.allSettled([
      ...clients.map((client) => this.stopClient(client)),
      ...this.tasks
    ]);
    this.temporaryClients.clear();
    this.notify();
  }

  private ensureActive(): ActiveConnection | undefined {
    if (!this.config.url) return undefined;
    if (this.active) return this.active;
    const config = this.config;
    const key = connectionKey(config);
    const client = this.createClient({
      url: config.url,
      token: config.token ?? "",
      changed: () => this.notify()
    });
    this.active = { key, client };
    return this.active;
  }

  private async inspectTemporary(action: "test" | "entities", url: string, token: string): Promise<HomeAssistantInspection> {
    let client: HomeAssistantClient | undefined;
    try {
      client = this.createClient({ url, token });
      this.temporaryClients.add(client);
      client.start();
      await this.track(client.waitUntilReady());
      return action === "test"
        ? client.status()
        : { entities: client.states().map(cloneEntity) };
    } catch (error) {
      const safe = safeError(error, url, token);
      if (action === "test") return { connected: false, error: safe };
      throw new Error(safe);
    } finally {
      if (client) {
        this.temporaryClients.delete(client);
        await this.stopClient(client);
      }
    }
  }

  private async stopClient(client: HomeAssistantClient): Promise<void> {
    try { await client.stop(); } catch { /* a disconnected client is already stopped */ }
  }

  private track<T>(task: Promise<T>): Promise<T> {
    const tracked = task.finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
    return tracked;
  }

  private notify(): void {
    try { this.changed?.(); } catch { /* status subscribers cannot break HA ownership */ }
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch { /* one consumer cannot break another */ }
    }
  }
}

function connectionKey(config: HomeAssistantConnectionConfig): string {
  return JSON.stringify([config.url, config.token ?? ""]);
}

function cloneEntity(entity: HAEntity): HAEntity {
  return { ...entity, attributes: { ...entity.attributes } };
}

function safeError(error: unknown, url: string, token: string): string {
  const message = error instanceof Error ? error.message : "Home Assistant connection failed.";
  if (message.includes(url) || (token.length > 0 && message.includes(token))) return "Home Assistant connection failed.";
  return message.slice(0, 240);
}
