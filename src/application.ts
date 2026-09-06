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
import type { VestaboardBoard } from "./vestaboardTypes.js";
import type { WebActions } from "./webServer.js";
import { applyCodexQuotaDemo, type CodexQuotaDemoState } from "./plugins/codexQuota/demo.js";

export async function createApplication(store: ConfigStore, dataDirectory: string, dryRun: boolean) {
  let config = store.get();
  let board: VestaboardBoard = config.board === "flagship" ? "flagship" : "note";
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let changed = (): void => {};
  let error: string | undefined;
  let deliveryError: string | undefined;
  let saveQueue = Promise.resolve();
  let demoDrops = 0;
  let pendingDemo: CodexQuotaDemoState | undefined;
  const pause = await PauseStore.open(dataDirectory);
  const login = new CodexLogin(() => changed());
  let codex = makeCodex();
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

  function elements() {
    const state = codex.getDisplayState();
    if (state.snapshot) state.snapshot = applyCodexQuotaDemo(state.snapshot, state.presentationDemo);
    if (!config.codex.enabled) { state.snapshot = undefined; state.statusMessage = undefined; }
    return createCodexElements(() => state);
  }
  function layout() { return config.layout ?? (config.codex.enabled ? defaultCodexLayout(board) : []); }
  function dimensions(value = board) { return { width: value === "note" ? 15 : 22, height: value === "note" ? 3 : 6 }; }

  function syncPause(): void {
    const missing = !dryRun && !config.transport.token && !config.transport.localApiKey;
    if (missing || store.repairError || error || pause.status().paused) {
      delivery.pause(missing ? "Configure a board connection" : store.repairError ?? error ?? "Updates paused");
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

  const status = () => ({
    board,
    desired: delivery.currentFrame(), lastSent: delivery.lastSent(),
    nextAttemptAt: delivery.status().nextAttemptAt?.getTime() ?? 0,
    lastSentAt: delivery.status().lastSuccessfulAt?.getTime(),
    ...pause.status(), deliveryError,
    configError: store.repairError ?? error ?? (!dryRun && !config.transport.token && !config.transport.localApiKey ? "Add a board connection in Board settings." : undefined),
    codex: { error: !codex.getDisplayState().snapshot || codex.getDisplayState().staleWindowIds.length ? codex.getDisplayState().statusMessage : undefined, collectedAt: collection.status().lastCompletedAt?.toISOString() },
    login: login.status()
  });

  const actions: WebActions = {
    status,
    config: () => store.getPublic(),
    elements: () => ({ elements: elements().map((element) => ({ id: element.id, label: element.label, height: element.height, preview: element.render(dimensions().width) })), defaultLayout: config.codex.enabled ? defaultCodexLayout(board) : [] }),
    preview: (input) => {
      const value = input as { layout: LayoutEntry[]; board?: string };
      const previewBoard = value.board === "note" || value.board === "flagship" ? value.board : board;
      return composeElements(elements(), value.layout, dimensions(previewBoard));
    },
    save: async (input) => {
      const task = saveQueue.then(async () => {
        const candidate = store.preview(input as AppConfig);
        const candidateBoard = candidate.board === "auto" ? board : candidate.board;
        composeElements(elements(), candidate.layout ?? (candidate.codex.enabled ? defaultCodexLayout(candidateBoard) : []), dimensions(candidateBoard));
        const codexChanged = JSON.stringify(config.codex) !== JSON.stringify(candidate.codex);
        const targetChanged = JSON.stringify(config.transport) !== JSON.stringify(candidate.transport) || config.board !== candidate.board;
        if (codexChanged) await collection.stop();
        try {
          config = await store.save(input as AppConfig);
          if (codexChanged) codex = makeCodex();
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
    }
  };

  return {
    actions,
    onChange(callback: () => void) { changed = callback; },
    async start() {
      await resolveBoard();
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
      await Promise.all([delivery.stop(), collection.stop(), login.stop(), saveQueue]);
    }
  };
}
