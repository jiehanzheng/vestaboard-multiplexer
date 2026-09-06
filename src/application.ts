import { ConfigStore, type AppConfig } from "./config.js";
import { composeElements, type LayoutEntry } from "./elements.js";
import { createCodexElements, defaultCodexLayout } from "./plugins/codexQuota/elements.js";
import { createCodexQuotaPlugin } from "./plugins/codexQuota/plugin.js";
import { DeliveryController } from "./runtime/delivery.js";
import { CollectionController } from "./runtime/collection.js";
import { createVestaboardClient } from "./vestaboard.js";
import { createVestaboardBoardResolver } from "./vestaboardBoard.js";
import { formatStartupMessage } from "./startupMessage.js";
import { PauseStore } from "./pause.js";
import { CodexLogin } from "./codexLogin.js";
import { createHomeAssistantClient, haPauseBinding, readHAPause, type HAEntity, type HomeAssistantClient, type HomeAssistantClientOptions } from "./homeAssistant.js";
import { createWaterHeater, validateWaterHeaterConfig, type WaterHeater, type WaterHeaterConfig } from "./plugins/waterHeater.js";
import type { VestaboardBoard } from "./vestaboardTypes.js";
import type { WebActions } from "./webServer.js";
import { applyCodexQuotaDemo, type CodexQuotaDemoState } from "./plugins/codexQuota/demo.js";

export interface ApplicationDependencies {
  createHomeAssistantClient?: (options: HomeAssistantClientOptions) => HomeAssistantClient;
}

export async function createApplication(store: ConfigStore, dataDirectory: string, dryRun: boolean, dependencies: ApplicationDependencies = {}) {
  let config = store.get();
  let board: VestaboardBoard = config.board === "flagship" ? "flagship" : "note";
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let changed = (): void => {};
  let error: string | undefined;
  let homeAssistantError: string | undefined;
  let deliveryError: string | undefined;
  let saveQueue = Promise.resolve();
  let demoDrops = 0;
  let pendingDemo: CodexQuotaDemoState | undefined;
  const pause = await PauseStore.open(dataDirectory);
  const login = new CodexLogin(() => changed());
  let codex = makeCodex();
  let water: WaterHeater = createWaterHeater(config.water);
  let haClient: HomeAssistantClient | undefined;
  let haEntities: HAEntity[] = [];
  let haConnectionKey: string | undefined;
  let haSourceUrl = config.ha.url;
  const temporaryHAClients = new Set<HomeAssistantClient>();
  const makeHomeAssistantClient = dependencies.createHomeAssistantClient ?? createHomeAssistantClient;
  const collection = new CollectionController({
    intervalMs: config.codex.pollIntervalSeconds * 1000,
    collect: async () => { if (config.codex.enabled) await codex.collect(); },
    onCollected: () => refresh()
  });
  const delivery = new DeliveryController({
    intervalMs: config.updateIntervalMinutes * 60_000,
    send: async (message) => {
      try {
        await createVestaboardClient({ dryRun, ...config.transport }).send(message);
        deliveryError = undefined;
      } catch {
        deliveryError = "Board update failed. Check the connection and token; the next attempt will respect the update interval.";
        throw new Error(deliveryError);
      }
    }
  });
  delivery.onStatusChange(() => changed());

  function makeCodex() {
    return createCodexQuotaPlugin({
      fixture: config.codex.source === "fixture",
      ...config.codex,
      board: async () => board,
      demoDurationMs: config.codex.demoPauseMinutes * 60_000,
      takeDemoMode: () => { const value = pendingDemo; pendingDemo = undefined; return value; }
    });
  }

  function elements(waterForRender = water) {
    const state = codex.getDisplayState();
    if (state.snapshot) state.snapshot = applyCodexQuotaDemo(state.snapshot, state.presentationDemo);
    if (!config.codex.enabled) { state.snapshot = undefined; state.statusMessage = undefined; }
    return [...createCodexElements(() => state), ...waterForRender.elements()];
  }
  function layout() {
    if (config.layout) return config.layout;
    return config.codex.enabled ? defaultCodexLayout(board) : [];
  }
  function dimensions(value = board) { return { width: value === "note" ? 15 : 22, height: value === "note" ? 3 : 6 }; }

  async function applyHomeAssistantState(client: HomeAssistantClient, key: string): Promise<void> {
    try {
      if (key !== haConnectionKey || client !== haClient || stopped) return;
      haEntities = client.states();
      water.update(config.water, haEntities);
      const haPause = client.status().connected ? readHAPause(config.ha, haEntities) : undefined;
      await applyHomeAssistantPause(haPause, haPauseBinding(config.ha));
      if (key !== haConnectionKey || client !== haClient || stopped) return;
      await refresh();
    } catch {
      if (key !== haConnectionKey || client !== haClient || stopped) return;
      homeAssistantError = "Could not apply Home Assistant state.";
      delivery.pause("Home Assistant state unavailable");
    }
    changed();
  }

  async function applyHomeAssistantPause(value: boolean | undefined, key: string | undefined): Promise<void> {
    if (value === undefined) return;
    if (value) delivery.pause("Paused by Home Assistant");
    try {
      await pause.setHA(value, key);
      homeAssistantError = undefined;
      if (!value) syncPause();
    } catch {
      homeAssistantError = "Could not persist Home Assistant pause state.";
      delivery.pause("Home Assistant pause state unavailable");
    }
  }

  async function syncHomeAssistant(): Promise<void> {
    if (stopped) {
      haClient?.stop();
      haClient = undefined;
      return;
    }
    const nextKey = homeAssistantConnectionKey(config.ha);
    if (nextKey === haConnectionKey) {
      water.update(config.water, haEntities);
      try {
        const haPause = haClient?.status().connected ? readHAPause(config.ha, haEntities) : undefined;
        await applyHomeAssistantPause(haPause, haPauseBinding(config.ha));
        if (!stopped) {
          syncPause();
          await refresh();
        }
      } catch {
        homeAssistantError = "Could not apply Home Assistant pause state.";
        delivery.pause("Home Assistant pause state unavailable");
        changed();
      }
      return;
    }

    const sourceChanged = haSourceUrl !== config.ha.url;
    haSourceUrl = config.ha.url;
    haClient?.stop();
    haClient = undefined;
    haEntities = [];
    haConnectionKey = nextKey;
    homeAssistantError = undefined;
    // Entity IDs are local to a Home Assistant instance, so a URL change cannot reuse readings.
    if (sourceChanged) water = createWaterHeater(config.water);
    water.update(config.water, haEntities);
    if (!config.ha.url) {
      changed();
      return;
    }

    const key = nextKey;
    const client = makeHomeAssistantClient({
      url: config.ha.url,
      token: config.ha.token ?? "",
      changed: () => applyHomeAssistantState(client, key)
    });
    haClient = client;
    client.start();
    changed();
  }

  function syncPause(): void {
    const missing = !dryRun && !config.transport.token && !config.transport.localApiKey;
    if (missing || store.repairError || error || homeAssistantError || pause.status().paused) {
      delivery.pause(missing ? "Configure a board connection" : store.repairError ?? error ?? homeAssistantError ?? "Updates paused");
    } else { delivery.resume(); }
  }

  async function refresh(): Promise<void> {
    if (stopped) return;
    clearTimeout(timer);
    try {
      const frame = composeElements(elements(), layout(), dimensions());
      error = undefined;
      delivery.updateFrame(frame);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Unable to render layout";
      delivery.clearFrame();
    }
    syncPause();
    await delivery.attempt();
    changed();
    if (stopped) return;
    const next = delivery.status().nextAttemptAt?.getTime() ?? 0;
    const delay = next > Date.now() ? Math.min(60_000, next - Date.now()) : 60_000;
    clearTimeout(timer);
    timer = setTimeout(() => { void refresh(); }, delay);
  }

  async function resolveBoard(): Promise<void> {
    const client = createVestaboardClient({ dryRun: true, ...config.transport });
    board = await createVestaboardBoardResolver({ preference: config.board, detectBoard: client.detectBoard, logger: console }).resolve();
  }

  const status = () => {
    const codexState = codex.getDisplayState();
    const deliveryStatus = delivery.status();
    return {
      board,
      desired: delivery.currentFrame(), lastSent: delivery.lastSent(),
      nextAttemptAt: deliveryStatus.nextAttemptAt?.getTime() ?? 0,
      lastSentAt: deliveryStatus.lastSuccessfulAt?.getTime(),
      ...pause.status(), deliveryError,
      configError: store.repairError ?? error ?? (!dryRun && !config.transport.token && !config.transport.localApiKey ? "Add a board connection in Board settings." : undefined),
      codex: { error: !codexState.snapshot || codexState.staleWindowIds.length ? codexState.statusMessage : undefined, collectedAt: collection.status().lastCompletedAt?.toISOString() },
      homeAssistant: { ...(haClient?.status() ?? { connected: false }), ...(homeAssistantError ? { error: homeAssistantError } : {}) },
      water: water.status(),
      login: login.status()
    };
  };

  const actions: WebActions = {
    status,
    config: () => store.getPublic(),
    elements: () => ({ elements: elements().map((element) => ({ id: element.id, label: element.label, height: element.height, preview: element.render(dimensions().width) })), defaultLayout: config.codex.enabled ? defaultCodexLayout(board) : [] }),
    preview: (input) => {
      const value = input as { layout: LayoutEntry[]; board?: string; water?: WaterHeaterConfig };
      const previewBoard = value.board === "note" || value.board === "flagship" ? value.board : board;
      let previewWater = water;
      if (value.water !== undefined) {
        const waterErrors = validateWaterHeaterConfig(value.water);
        if (waterErrors.length) throw new Error(waterErrors[0]);
        if (JSON.stringify(value.water) !== JSON.stringify(config.water)) {
          previewWater = createWaterHeater(value.water);
          previewWater.update(value.water, haEntities);
        }
      }
      return composeElements(elements(previewWater), value.layout, dimensions(previewBoard));
    },
    save: async (input) => {
      const task = saveQueue.then(async () => {
        const candidate = store.preview(input as AppConfig);
        const candidateBoard = candidate.board === "auto" ? board : candidate.board;
        composeElements(elements(), candidate.layout ?? (candidate.codex.enabled ? defaultCodexLayout(candidateBoard) : []), dimensions(candidateBoard));
        const codexChanged = JSON.stringify(config.codex) !== JSON.stringify(candidate.codex);
        const targetChanged = JSON.stringify(config.transport) !== JSON.stringify(candidate.transport) || config.board !== candidate.board;
        const haChanged = JSON.stringify(config.ha) !== JSON.stringify(candidate.ha);
        const waterChanged = JSON.stringify(config.water) !== JSON.stringify(candidate.water);
        if (codexChanged) await collection.stop();
        try {
          await pause.bindHA(haPauseBinding(candidate.ha));
          syncPause();
          config = await store.save(input as AppConfig);
          if (codexChanged) codex = makeCodex();
          if (waterChanged) water.update(config.water, haEntities);
          if (haChanged) await syncHomeAssistant();
          collection.setInterval(config.codex.pollIntervalSeconds * 1000);
          delivery.setInterval(config.updateIntervalMinutes * 60_000);
          if (targetChanged) { delivery.clearLastSent(); await resolveBoard(); }
        } finally { if (codexChanged && !stopped) void collection.start(); }
        await refresh();
      });
      saveQueue = task.catch(() => {});
      await task;
      return store.getPublic();
    },
    pause: async (input) => {
      if (typeof (input as { paused?: unknown })?.paused !== "boolean") throw new Error("paused must be a boolean");
      await pause.setManual((input as { paused: boolean }).paused);
      await refresh();
      return status();
    },
    login: async (action) => {
      if (action === "start") login.start();
      if (action === "cancel") await login.cancel();
      if (action === "check") { await login.check(); collection.requestNow(); }
      return login.status();
    },
    homeAssistant: async (action, input) => {
      const value = input && typeof input === "object" ? input as { url?: unknown; token?: unknown } : {};
      const url = typeof value.url === "string" && value.url ? value.url : config.ha.url;
      const token = typeof value.token === "string" && value.token ? value.token : config.ha.token ?? "";
      if (!url) throw new Error("Home Assistant URL is required.");
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
      } catch {
        throw new Error("Invalid Home Assistant URL.");
      }
      const temporary = makeHomeAssistantClient({ url, token });
      temporaryHAClients.add(temporary);
      try {
        temporary.start();
        await temporary.waitUntilReady();
        return action === "test" ? temporary.status() : { entities: temporary.states() };
      } finally {
        temporaryHAClients.delete(temporary);
        temporary.stop();
      }
    }
  };

  return {
    actions,
    onChange(callback: () => void) { changed = callback; },
    async start() {
      await resolveBoard();
      await pause.bindHA(haPauseBinding(config.ha));
      await syncHomeAssistant();
      if (stopped) return;
      syncPause();
      await delivery.deliverStartup(formatStartupMessage({ plugins: config.codex.enabled ? [codex] : [], now: new Date(), board, transport: config.transport.localApiKey ? "local" : "cloud", timeZone: config.codex.timeZone }), 30_000);
      if (stopped) return;
      void collection.start();
      await refresh();
    },
    refresh: () => { collection.requestNow(); return refresh(); },
    demo() { pendingDemo = { pctDrops: ++demoDrops }; void refresh(); },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await saveQueue;
      haClient?.stop();
      haClient = undefined;
      for (const client of temporaryHAClients) client.stop();
      temporaryHAClients.clear();
      await pause.flush();
      await Promise.all([delivery.stop(), collection.stop(), login.stop()]);
    }
  };
}

function homeAssistantConnectionKey(config: { url: string; token?: string }): string {
  return JSON.stringify([config.url, config.token ?? ""]);
}
