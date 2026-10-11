import type { HAEntitiesRequest, HAEntitiesResponse, HAStatus } from "./contracts/homeAssistant.js";
import {
  createHomeAssistantClient,
  type HomeAssistantClient,
  type HAClientChange,
  type ReadonlyHAEntity,
  type HomeAssistantClientOptions
} from "./homeAssistant.js";

export interface HomeAssistantConnectionConfig {
  url: string;
  token?: string;
}

export interface HomeAssistantSnapshot {
  readonly source: string;
  readonly entities: readonly ReadonlyHAEntity[];
  readonly connected: boolean;
  readonly error?: string;
}

export interface HomeAssistantServiceOptions {
  createClient?: (options: HomeAssistantClientOptions) => HomeAssistantClient;
  changed?: () => void;
  logger?: Pick<Console, "info" | "warn">;
}

export type HomeAssistantInspection = HAStatus | HAEntitiesResponse;
export type HomeAssistantSnapshotListener = (snapshot: HomeAssistantSnapshot) => void;

export interface HomeAssistantServiceLike {
  configure(config: HomeAssistantConnectionConfig): void;
  snapshot(ids: readonly string[]): HomeAssistantSnapshot;
  status(): Omit<HomeAssistantSnapshot, "entities">;
  subscribe(ids: readonly string[], callback: HomeAssistantSnapshotListener): () => void;
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
  private readonly logger: Pick<Console, "info" | "warn">;
  private readonly listeners = new Set<{ ids: ReadonlySet<string>; callback: HomeAssistantSnapshotListener }>();
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly temporaryClients = new Set<HomeAssistantClient>();
  private config: HomeAssistantConnectionConfig = { url: "" };
  private active: ActiveConnection | undefined;
  private started = false;
  private stopped = false;
  private previousConnection: { connected: boolean; error?: string } | undefined;

  constructor(options: HomeAssistantServiceOptions = {}) {
    this.createClient = options.createClient ?? createHomeAssistantClient;
    this.changed = options.changed;
    this.logger = options.logger ?? console;
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

  status(): Omit<HomeAssistantSnapshot, "entities"> {
    const status = this.active?.client.status();
    return { source: this.config.url, connected: status?.connected ?? false, ...(status?.error ? { error: status.error } : {}) };
  }

  snapshot(ids: readonly string[]): HomeAssistantSnapshot {
    return Object.freeze({ ...this.status(), entities: this.active?.client.readEntities([...new Set(ids)]) ?? Object.freeze([]) });
  }

  subscribe(ids: readonly string[], callback: HomeAssistantSnapshotListener): () => void {
    const subscription = { ids: new Set(ids), callback };
    this.listeners.add(subscription);
    return () => this.listeners.delete(subscription);
  }

  start(): void {
    if (this.stopped) return;
    const wasStarted = this.started;
    const previous = this.active;
    this.started = true;
    const active = this.ensureActive();
    active?.client.start();
    if (!wasStarted || active !== previous) this.notify();
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
          : { entities: client.states() };
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
      changed: (change) => this.notify(change)
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
        : { entities: client.states() };
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

  private notify(change: HAClientChange = { kind: "connection" }): void {
    const status = this.status();
    const previous = this.previousConnection;
    if (status.error && (!previous || previous.error !== status.error || previous.connected)) {
      this.logger.warn(`Home Assistant connection failed: ${status.error}`);
    } else if (status.connected && previous && (!previous.connected || previous.error !== undefined)) {
      this.logger.info("Home Assistant connection recovered.");
    }
    this.previousConnection = { connected: status.connected, ...(status.error ? { error: status.error } : {}) };
    // UI connection changes do not require inspecting or copying entity data.
    if (!previous || previous.connected !== status.connected || previous.error !== status.error) {
      try { this.changed?.(); } catch { /* status subscribers cannot break HA ownership */ }
    }
    for (const subscription of this.listeners) {
      if (change.kind === "entity" && !subscription.ids.has(change.entityId)) continue;
      try { subscription.callback(this.snapshot([...subscription.ids])); } catch { /* one consumer cannot break another */ }
    }
  }

}

function connectionKey(config: HomeAssistantConnectionConfig): string {
  return JSON.stringify([config.url, config.token ?? ""]);
}

function safeError(error: unknown, url: string, token: string): string {
  const message = error instanceof Error ? error.message : "Home Assistant connection failed.";
  if (message.includes(url) || (token.length > 0 && message.includes(token))) return "Home Assistant connection failed.";
  return message.slice(0, 240);
}
