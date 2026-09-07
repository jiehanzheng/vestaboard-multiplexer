import { ConfigStore, type AppConfig } from "./config.js";
import { composeElements, type LayoutEntry } from "./elements.js";
import { createCodexIntegration } from "./plugins/codexQuota/integration.js";
import { createWaterHeaterIntegration } from "./plugins/waterHeater.js";
import { HomeAssistantService } from "./homeAssistantService.js";
import { PauseController } from "./pause.js";
import { DeliveryController, type DeliveryAttempt } from "./runtime/delivery.js";
import { createVestaboardClient } from "./vestaboard.js";
import { createVestaboardBoardResolver } from "./vestaboardBoard.js";
import { formatStartupMessage } from "./startupMessage.js";
import type { HomeAssistantClient, HomeAssistantClientOptions } from "./homeAssistant.js";
import type { VestaboardBoard } from "./vestaboardTypes.js";
import type { PreviewRequest, RuntimeStatus } from "./contracts/api.js";
import type { WebActions } from "./webServer.js";
import { LogBuffer } from "./logger.js";

export interface ApplicationDependencies {
  createHomeAssistantClient?: (options: HomeAssistantClientOptions) => HomeAssistantClient;
  createCodexIntegration?: typeof createCodexIntegration;
  createVestaboardClient?: typeof createVestaboardClient;
  now?: () => Date;
  logger?: LogBuffer;
}

/** Explicit wiring: modules interpret their own settings and cached readings. */
export async function createApplication(store: ConfigStore, directory: string, dryRun: boolean, dependencies: ApplicationDependencies = {}) {
  let config = store.get();
  let board: VestaboardBoard = config.board === "flagship" ? "flagship" : "note";
  let stopped = false;
  let ready = false;
  let changed = (): void => {};
  let renderError: string | undefined;
  let deliveryError: string | undefined;
  let saveError: string | undefined;
  let minute: ReturnType<typeof setInterval> | undefined;
  let startTask: Promise<void> | undefined;
  let onceTask: Promise<DeliveryAttempt | undefined> | undefined;
  let stopTask: Promise<void> | undefined;
  let saveQueue: Promise<void> = Promise.resolve();
  const now = dependencies.now ?? (() => new Date());
  const logs = dependencies.logger ?? new LogBuffer(console, now);
  const applicationLog = logs.child("application");
  logs.setSecrets([config.transport.token, config.transport.localApiKey, config.ha.token]);
  const makeBoard = dependencies.createVestaboardClient ?? createVestaboardClient;
  let previousHAConnected: boolean | undefined;
  const ha = new HomeAssistantService({
    createClient: dependencies.createHomeAssistantClient,
    changed: () => {
      const connected = ha.snapshot().connected;
      if (previousHAConnected !== undefined && previousHAConnected !== connected) {
        (connected ? logs.child("home-assistant").info : logs.child("home-assistant").warn)(connected ? "Home Assistant connection recovered." : "Home Assistant connection failed.");
      }
      previousHAConnected = connected;
      changed();
    }
  });
  const pause = await PauseController.open(directory, ha, requestComposition);
  const codex = (dependencies.createCodexIntegration ?? createCodexIntegration)(config.codex, { changed: requestComposition, now, logger: logs.child("codex") });
  const water = createWaterHeaterIntegration(config.water, ha, requestComposition);
  const plugins = [codex, water];
  let lastCodexDiagnostic: string | undefined;
  let lastWaterDiagnostic: string | undefined;
  function observeDiagnostics(): void {
    const codexDiagnostic = codex.status().error;
    if (lastCodexDiagnostic !== undefined && codexDiagnostic !== lastCodexDiagnostic) {
      (codexDiagnostic ? logs.child("codex").warn : logs.child("codex").info)(codexDiagnostic ?? "Codex quota collection recovered.");
    }
    lastCodexDiagnostic = codexDiagnostic;
    const waterStatus = water.status();
    const waterDiagnostic = JSON.stringify({
      error: waterStatus.error,
      inputs: Object.fromEntries(Object.entries(waterStatus.inputs).map(([name, input]) => [name, { error: input.error, retained: input.retained }]))
    });
    if (lastWaterDiagnostic !== undefined && waterDiagnostic !== lastWaterDiagnostic) {
      (waterStatus.error ? logs.child("water").warn : logs.child("water").info)(waterStatus.error ?? "Water heater diagnostics recovered.");
    }
    lastWaterDiagnostic = waterDiagnostic;
  }
  const delivery = new DeliveryController({
    intervalMs: config.updateIntervalMinutes * 60_000, now,
    logger: logs.child("delivery"),
    send: async (frame) => {
      try {
        await makeBoard({ dryRun, ...config.transport }).send(frame);
        deliveryError = undefined;
      } catch {
        deliveryError = "Board update failed. Check the connection and credentials; the next attempt will respect the update interval.";
        throw new Error(deliveryError);
      }
    }
  });
  delivery.onStatusChange(() => changed());

  function dimensions(value = board) {
    return value === "note" ? { width: 15, height: 3 } : { width: 22, height: 6 };
  }
  function defaultLayout(value = board): LayoutEntry[] {
    return codex.defaultLayout(value);
  }
  function elements(draft?: Pick<PreviewRequest, "codex" | "water">) {
    return [...codex.elements(draft?.codex), ...water.elements(draft?.water)];
  }
  function compose(layout: LayoutEntry[] | null = config.layout, value = board, draft?: Pick<PreviewRequest, "codex" | "water">) {
    return composeElements(elements(draft), layout ?? codex.defaultLayout(value, draft?.codex), dimensions(value));
  }
  function configurationError() {
    return store.getPublic().error ?? (!dryRun && !config.transport.token && !config.transport.localApiKey ? "Add a board connection in Board settings." : undefined);
  }
  let lastPauseState: boolean | undefined;
  function syncPause() {
    const state = pause.status();
    const reason = configurationError() ?? saveError ?? renderError ?? state.persistenceError ?? (state.paused ? state.pauseReason ?? "Updates paused" : undefined);
    if (reason) delivery.pause(reason); else delivery.resume();
    if (lastPauseState !== undefined && state.paused !== lastPauseState) {
      (state.paused ? logs.child("pause").warn : logs.child("pause").info)(state.paused ? `Updates paused: ${reason ?? "paused"}` : "Updates resumed.");
    }
    lastPauseState = state.paused;
  }
  function requestComposition() {
    if (!ready || stopped) return;
    try { delivery.updateFrame(compose()); renderError = undefined; }
    catch (error) { renderError = error instanceof Error ? error.message : "Unable to render layout"; delivery.clearFrame(); }
    observeDiagnostics();
    syncPause();
    changed();
  }
  async function resolveBoard(settings: AppConfig) {
    const client = makeBoard({ dryRun: true, ...settings.transport, logger: logs.child("vestaboard") });
    return createVestaboardBoardResolver({ preference: settings.board, detectBoard: client.detectBoard, logger: logs.child("vestaboard") }).resolve();
  }
  async function prepare() {
    await pause.configure(config.ha);
    if (stopped) return;
    await ha.configure(config.ha);
    board = await resolveBoard(config);
    if (stopped) return;
    ready = true;
    requestComposition();
  }
  function status(): RuntimeStatus {
    return {
      board, dryRun, desired: delivery.currentFrame(), lastSent: delivery.lastSent(),
      nextAttemptAt: delivery.status().nextAttemptAt?.getTime() ?? 0,
      lastSentAt: delivery.status().lastSuccessfulAt?.getTime(),
      ...pause.status(), pauseReason: delivery.status().pauseReason,
      persistenceError: pause.status().persistenceError ?? saveError,
      configError: configurationError() ?? renderError, deliveryError,
      codex: codex.status(), homeAssistant: { connected: ha.snapshot().connected, error: ha.snapshot().error },
      water: water.status(), login: codex.loginStatus()
    };
  }
  const actions: WebActions = {
    status, config: () => store.getPublic(),
    logs: () => logs.snapshot(),
    subscribeLogs: (listener) => logs.subscribe(listener),
    elements: () => ({
      elements: elements().map((element) => ({
        id: element.id,
        label: element.label,
        height: element.height,
        ...(element.minWidth === undefined ? {} : { minWidth: element.minWidth }),
        preview: element.render(dimensions().width)
      })),
      defaultLayout: defaultLayout(),
      defaultLayouts: { note: defaultLayout("note"), flagship: defaultLayout("flagship") }
    }),
    preview: (input) => compose(input.layout, input.board === "note" || input.board === "flagship" ? input.board : board, input),
    save: async (input) => {
      const task = saveQueue.then(async () => {
        if (stopped) throw new Error("Application is stopping.");
        await startTask;
        if (stopped) throw new Error("Application is stopping.");
        const candidate = store.preview(input as AppConfig);
        logs.setSecrets([config.transport.token, config.transport.localApiKey, config.ha.token, candidate.transport.token, candidate.transport.localApiKey, candidate.ha.token]);
        const targetChanged = JSON.stringify(config.transport) !== JSON.stringify(candidate.transport) || config.board !== candidate.board;
        // Validate against the new board before saving: an auto-detected Note
        // must not inherit a persisted six-row Flagship layout.
        const candidateBoard = targetChanged ? await resolveBoard(candidate) : board;
        if (stopped) throw new Error("Application is stopping.");
        compose(candidate.layout, candidateBoard, candidate);
        // Hold delivery across asynchronous configuration changes so it cannot
        // combine a new target with a frame from partially configured plugins.
        ready = false;
        delivery.pause("Applying configuration");
        try {
          config = await store.save(input as AppConfig);
          saveError = undefined;
          await pause.configure(config.ha);
          if (stopped) return;
          await codex.configure(config.codex);
          water.configure(config.water);
          await ha.configure(config.ha);
          if (targetChanged) { await delivery.resetTarget(); board = candidateBoard; }
          delivery.setInterval(config.updateIntervalMinutes * 60_000);
          applicationLog.info("Configuration applied.");
        } catch (error) {
          saveError = "Could not apply saved settings. Check the configuration directory and try again.";
          applicationLog.error(saveError);
          throw error;
        } finally { ready = !stopped; requestComposition(); }
      });
      saveQueue = task.catch(() => {});
      await task;
      return store.getPublic();
    },
    pause: async (input) => { await pause.setManual(input.paused); applicationLog.info(input.paused ? "Manual pause requested." : "Manual resume requested."); requestComposition(); return status(); },
    login: async (action) => { await codex.loginAction(action); return codex.loginStatus(); },
    homeAssistant: (action, input) => ha.inspect(action, input)
  };
  return {
    actions,
    onChange(callback: () => void) { changed = callback; },
    start() {
      if (stopped) return Promise.resolve();
      if (startTask) return startTask;
      startTask = (async () => {
        applicationLog.info(`Starting application (${dryRun ? "dry-run" : "live"}).`);
        await prepare();
        if (stopped) return;
        ha.start();
        codex.start();
        syncPause();
        await delivery.deliverStartup(formatStartupMessage({ plugins: plugins.filter((plugin) => plugin.enabled), now: now(), board, transport: config.transport.localApiKey ? "local" : "cloud", timeZone: config.codex.timeZone }), 30_000);
        if (stopped) return;
        requestComposition();
        minute = setInterval(requestComposition, 60_000);
        void delivery.startScheduler();
        applicationLog.info("Application started.");
      })();
      return startTask;
    },
    runOnce() {
      if (stopped) return Promise.resolve(undefined);
      onceTask = (async () => {
        await prepare();
        if (stopped) return;
        ha.start();
        await Promise.all([ha.collectInitial().catch(() => {}), codex.collectInitial()]);
        if (stopped) return;
        requestComposition();
        return delivery.attempt();
      })();
      return onceTask;
    },
    stop() {
      if (stopTask) return stopTask;
      stopped = true;
      applicationLog.info("Stopping application.");
      clearInterval(minute);
      const stopDelivery = delivery.stop();
      water.stop();
      const stopModules = Promise.all([codex.stop(), ha.stop()]);
      stopTask = (async () => {
        await Promise.all([startTask?.catch(() => {}), onceTask?.catch(() => {}), saveQueue, stopModules]);
        await Promise.all([stopDelivery, pause.stop()]);
      })();
      return stopTask;
    }
  };
}
