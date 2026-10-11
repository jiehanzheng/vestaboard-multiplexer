import type { LayoutDecision } from "./contracts/layout.js";
import { mergeHABlocks } from "./plugins/haBlock/config.js";
import { createHABlocksIntegration, haBlockEntityIds } from "./plugins/haBlock.js";
import { ConfigStore, type AppConfig } from "./config.js";
import { composeElements, type LayoutEntry } from "./elements.js";
import { createCodexIntegration } from "./plugins/codexQuota/integration.js";
import { createWaterHeaterIntegration, waterEntityIds } from "./plugins/waterHeater.js";
import { HomeAssistantService } from "./homeAssistantService.js";
import { PauseController } from "./pause.js";
import { composePauseOverlay } from "./pauseOverlay.js";
import { DeliveryController, type DeliveryAttempt } from "./runtime/delivery.js";
import { createVestaboardClient, type VestaboardMessage } from "./vestaboard.js";
import { createVestaboardBoardResolver, type VestaboardBoardResolver } from "./vestaboardBoard.js";
import { formatStartupMessage } from "./startupMessage.js";
import type { HomeAssistantClient, HomeAssistantClientOptions } from "./homeAssistant.js";
import type { VestaboardBoard } from "./vestaboardTypes.js";
import type { PreviewRequest, RuntimeStatus } from "./contracts/api.js";
import type { ConfigSaveResponse } from "./contracts/config.js";
import type { RuntimeActions } from "./runtime/actions.js";
import { LogBuffer } from "./logger.js";

export interface ApplicationDependencies {
  createHomeAssistantClient?: (options: HomeAssistantClientOptions) => HomeAssistantClient;
  createCodexIntegration?: typeof createCodexIntegration;
  createVestaboardClient?: typeof createVestaboardClient;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  now?: () => Date;
  logger?: LogBuffer;
}

function frameMatchesBoard(frame: VestaboardMessage | undefined, board: VestaboardBoard): frame is VestaboardMessage {
  const expected = board === "note" ? { width: 15, height: 3 } : { width: 22, height: 6 };
  return Boolean(frame?.characters?.length === expected.height && frame.characters.every((row) => row.length === expected.width));
}
/** Explicit wiring: modules interpret their own settings and cached readings. */
export async function createApplication(store: ConfigStore, directory: string, dryRun: boolean, dependencies: ApplicationDependencies = {}) {
  let config = store.get();
  let board: VestaboardBoard = config.board === "flagship" ? "flagship" : "note";
  let stopped = false;
  let ready = false;
  let changed = (): void => {};
  let layoutSelection: LayoutDecision[] | undefined;
  let renderError: string | undefined;
  let deliveryError: string | undefined;
  let saveError: string | undefined;
  let minute: ReturnType<typeof setInterval> | undefined;
  let startTask: Promise<void> | undefined;
  let onceTask: Promise<DeliveryAttempt | undefined> | undefined;
  let stopTask: Promise<void> | undefined;
  let saveQueue: Promise<unknown> = Promise.resolve();
  let boardResolver: VestaboardBoardResolver | undefined;
  let boardResolverCanDetect = false;
  let boardResolutionTask: Promise<void> | undefined;
  let frozenBase: VestaboardMessage | undefined;
  let frozenBoard: VestaboardBoard | undefined;
  let lastSuccessfulBase: VestaboardMessage | undefined;
  let lastSuccessfulBoard: VestaboardBoard | undefined;
  const now = dependencies.now ?? (() => new Date());
  const setIntervalImpl = dependencies.setInterval ?? setInterval;
  const clearIntervalImpl = dependencies.clearInterval ?? clearInterval;
  const logs = dependencies.logger ?? new LogBuffer(console, now);
  const applicationLog = logs.child("application");
  logs.setSecrets([config.transport.token, config.transport.localApiKey, config.ha.token]);
  const makeBoard = dependencies.createVestaboardClient ?? createVestaboardClient;
  const ha = new HomeAssistantService({
    createClient: dependencies.createHomeAssistantClient,
    changed: notifyChanged,
    logger: logs.child("home-assistant")
  });
  const pause = await PauseController.open(directory, ha, requestComposition);
  const codex = (dependencies.createCodexIntegration ?? createCodexIntegration)(config.codex, { changed: requestComposition, now, logger: logs.child("codex") });
  const water = createWaterHeaterIntegration(config.water, ha, requestComposition, logs.child("water"), now);
  const haBlocks = createHABlocksIntegration(config.haBlocks, ha, requestComposition, logs.child("ha-block"), now);
  const plugins = [codex, water, haBlocks];
  const delivery = new DeliveryController({
    limits: config.updateLimits, now,
    logger: logs.child("delivery"),
    send: async (frame, usePauseAnimation) => {
      const stateAtAttempt = pause.status();
      const boardAtAttempt = board;
      const baseAtAttempt = stateAtAttempt.paused && frozenBoard === boardAtAttempt && frozenBase ? structuredClone(frozenBase) : structuredClone(frame);
      try {
        const localMessageTransition = usePauseAnimation
          ? config.transport.pauseMessageTransition ?? config.transport.localMessageTransition
          : config.transport.localMessageTransition;
        await makeBoard({ dryRun, ...config.transport, localMessageTransition, logger: logs.child("vestaboard") }).send(frame);
        deliveryError = undefined;
        if (board === boardAtAttempt && frameMatchesBoard(baseAtAttempt, boardAtAttempt)) {
          lastSuccessfulBase = baseAtAttempt;
          lastSuccessfulBoard = boardAtAttempt;
        }
      } catch {
        deliveryError = "Board update failed. Check the connection and credentials; the next attempt will respect the update interval.";
        throw new Error(deliveryError);
      }
    }
  });
  delivery.onStatusChange(notifyChanged);

  function dimensions(value = board) {
    return value === "note" ? { width: 15, height: 3 } : { width: 22, height: 6 };
  }
  function defaultLayout(value = board): LayoutEntry[] {
    return codex.defaultLayout(value);
  }
  function elements(draft?: Pick<PreviewRequest, "codex" | "water" | "haBlock" | "haBlocks">) {
    const waterConfig = draft?.water ?? config.water;
    const blocks = mergeHABlocks(config.haBlocks, draft?.haBlocks, draft?.haBlock);
    const snapshot = ha.snapshot([...waterEntityIds(waterConfig), ...haBlockEntityIds(blocks)]);
    return [...codex.elements(draft?.codex), ...water.elements(waterConfig, snapshot), ...haBlocks.elements(blocks, snapshot)];
  }
  function compose(layout: LayoutEntry[] | null = config.layout, value = board, draft?: Pick<PreviewRequest, "codex" | "water" | "haBlock" | "haBlocks">, onSelection?: (selection: LayoutDecision[]) => void) {
    return composeElements(elements(draft), layout ?? codex.defaultLayout(value, draft?.codex), dimensions(value), value, onSelection);
  }
  function configurationError() {
    return store.getPublic().error ?? (!dryRun && !config.transport.token && !config.transport.localApiKey ? "Configure a board connection in config.json." : undefined);
  }
  function boardDetectionPending(): boolean {
    return boardResolverCanDetect && boardResolver?.resolution().source === "assumed";
  }
  let lastDeliveryPauseReason: string | undefined;
  function syncPause() {
    const state = pause.status();
    const reason = configurationError() ?? saveError ?? renderError ?? state.persistenceError ?? (boardDetectionPending() ? "Board size detection pending." : undefined);
    if (reason) delivery.pause(reason); else delivery.resume();
    const effectiveReason = delivery.status().paused ? delivery.status().pauseReason ?? reason ?? "paused" : undefined;
    if (effectiveReason && effectiveReason !== lastDeliveryPauseReason) logs.child("pause").warn(`Updates paused: ${effectiveReason}`);
    if (!effectiveReason && lastDeliveryPauseReason) logs.child("pause").info("Updates resumed.");
    lastDeliveryPauseReason = effectiveReason;
  }
  let compositionDirty = false;
  let notificationDirty = false;
  let flushQueued = false;
  let flushing = false;
  let publishedStatus: string | undefined;
  function scheduleFlush() {
    if (flushQueued || flushing || stopped) return;
    flushQueued = true;
    queueMicrotask(flushPending);
  }
  function notifyChanged() { notificationDirty = true; scheduleFlush(); }
  function requestComposition() {
    if (!ready || stopped) return;
    compositionDirty = true;
    scheduleFlush();
  }
  // HA consumers update together before one coherent render; no debounce delays playback changes.
  function flushPending() {
    flushQueued = false;
    if (stopped || flushing) return;
    flushing = true;
    try {
      if (compositionDirty) { compositionDirty = false; composeNow(); }
      if (notificationDirty) {
        notificationDirty = false;
        const next = JSON.stringify(status());
        if (next !== publishedStatus) { publishedStatus = next; changed(); }
      }
    } finally {
      flushing = false;
      if (compositionDirty || notificationDirty) scheduleFlush();
    }
  }
  function composeNow() {
    if (!ready || stopped) return;
    const state = pause.status();
    const userPaused = state.manualPause || state.haPause;
    try {
      if (userPaused) {
        if (!frozenBase || frozenBoard !== board) {
          const sent = lastSuccessfulBoard === board && frameMatchesBoard(lastSuccessfulBase, board) ? lastSuccessfulBase : delivery.lastSent();
          const current = delivery.currentFrame();
          frozenBase = frameMatchesBoard(sent, board) ? sent : frameMatchesBoard(current, board) ? current : compose();
          frozenBoard = board;
        }
        delivery.updateFrame(composePauseOverlay(frozenBase, config.pauseOverlay, board), userPaused);
      } else {
        frozenBase = undefined;
        frozenBoard = undefined;
        delivery.updateFrame(compose(config.layout, board, undefined, (selection) => { layoutSelection = selection; }), userPaused);
      }
      renderError = undefined;
    }
    catch (error) { renderError = error instanceof Error ? error.message : "Unable to render layout"; delivery.clearFrame(); }
    syncPause();
    notifyChanged();
  }
  async function resolveBoard(settings: AppConfig): Promise<{ board: VestaboardBoard; resolver: VestaboardBoardResolver; canDetect: boolean }> {
    const client = makeBoard({ dryRun: true, ...settings.transport, logger: logs.child("vestaboard") });
    const resolver = createVestaboardBoardResolver({ preference: settings.board, detectBoard: client.detectBoard, logger: logs.child("vestaboard") });
    return { board: await resolver.resolve(), resolver, canDetect: settings.board === "auto" && Boolean(client.detectBoard) };
  }
  function retryBoardDetection(): void {
    if (!ready || boardResolutionTask || stopped || !boardResolver || !boardResolverCanDetect || boardResolver.resolution().source === "confirmed") return;
    const resolver = boardResolver;
    const resolution = saveQueue.then(async () => {
      if (stopped || !ready || resolver !== boardResolver || resolver.resolution().source === "confirmed") return;
      const nextBoard = await resolver.resolve();
      if (stopped || resolver !== boardResolver || resolver.resolution().source !== "confirmed") return;
      if (nextBoard === board) return;
      // Hold the delivery queue while the target changes so a Note frame cannot
      // be written after detection confirms a Flagship board (or vice versa).
      ready = false;
      board = nextBoard;
      await delivery.resetTarget();
      lastSuccessfulBase = undefined;
      lastSuccessfulBoard = undefined;
      if (stopped || resolver !== boardResolver) return;
      ready = true;
    });
    let ownedResolution!: Promise<void>;
    ownedResolution = resolution.finally(() => {
      if (boardResolutionTask !== ownedResolution) return;
      boardResolutionTask = undefined;
      if (!stopped && ready) requestComposition();
    });
    boardResolutionTask = ownedResolution;
    saveQueue = ownedResolution.catch(() => {});
  }
  async function prepare() {
    await pause.configure(config.ha);
    if (stopped) return;
    await ha.configure(config.ha);
    const resolved = await resolveBoard(config);
    board = resolved.board;
    boardResolver = resolved.resolver;
    boardResolverCanDetect = resolved.canDetect;
    if (stopped) return;
  }
  function status(): RuntimeStatus {
    const pauseState = pause.status();
    const deliveryState = delivery.status();
    return {
      board, dryRun, layoutSelection, desired: delivery.currentFrame(), lastSent: delivery.lastSent(),
      pauseBackground: pauseState.manualPause || pauseState.haPause ? frozenBase : undefined,
      nextAttemptAt: deliveryState.nextAttemptAt?.getTime() ?? 0,
      lastSentAt: deliveryState.lastSuccessfulAt?.getTime(),
      updateLimits: deliveryState.limits,
      pendingDelivery: deliveryState.pending,
      ...pauseState, paused: deliveryState.paused || pauseState.paused,
      pauseReason: deliveryState.pauseReason ?? pauseState.pauseReason,
      persistenceError: pauseState.persistenceError ?? saveError,
      configError: configurationError() ?? renderError, deliveryError,
      codex: codex.status(), homeAssistant: (() => { const { source: _source, ...status } = ha.status(); return status; })(),
      water: water.status(), haBlocks: haBlocks.status(), login: codex.loginStatus()
    };
  }
  const actions: RuntimeActions = {
    status, config: () => store.getPublic(),
    logs: () => logs.snapshot(),
    subscribeLogs: (listener) => logs.subscribe(listener),
    elements: () => ({
      elements: elements().map((element) => ({
        id: element.id,
        label: element.label,
        state: element.state,
        height: element.height,
        ...(element.minWidth === undefined ? {} : { minWidth: element.minWidth }),
        // Unplaced blocks may be sized for a larger supported board; the catalog must still load.
        preview: element.render(Math.max(dimensions().width, element.minWidth ?? 1))
      })),
      defaultLayout: defaultLayout(),
      defaultLayouts: { note: defaultLayout("note"), flagship: defaultLayout("flagship") }
    }),
    preview: (input) => {
      let selection: LayoutDecision[] = [];
      const frame = compose(input.layout, input.board === "note" || input.board === "flagship" ? input.board : board, input, (value) => { selection = value; });
      return { ...frame, selection };
    },
    save: async (input) => {
      const task = saveQueue.then(async (): Promise<ConfigSaveResponse> => {
        if (stopped) throw new Error("Application is stopping.");
        await startTask;
        if (stopped) throw new Error("Application is stopping.");
        let candidate: AppConfig;
        try { candidate = store.preview(input); }
        catch (error) { applicationLog.error(configurationFailure(error)); throw error; }
        const pauseOverlayChanged = input.pauseOverlay !== undefined && JSON.stringify(input.pauseOverlay) !== JSON.stringify(config.pauseOverlay);
        const haPauseChanged = input.ha === null || (input.ha !== undefined && input.ha.pause !== undefined && JSON.stringify(input.ha.pause) !== JSON.stringify(config.ha.pause));
        logs.setSecrets([config.transport.token, config.transport.localApiKey, config.ha.token, candidate.transport.token, candidate.transport.localApiKey, candidate.ha.token]);
        const targetChanged = JSON.stringify(config.transport) !== JSON.stringify(candidate.transport) || config.board !== candidate.board;
        // Validate against the new board before saving: an auto-detected Note
        // must not inherit a persisted six-row Flagship layout.
        let candidateBoard: VestaboardBoard;
        let candidateResolver: VestaboardBoardResolver | undefined;
        let candidateResolverCanDetect = false;
        try {
          if (targetChanged) {
            const resolved = await resolveBoard(candidate);
            candidateBoard = resolved.board;
            candidateResolver = resolved.resolver;
            candidateResolverCanDetect = resolved.canDetect;
          } else {
            candidateBoard = board;
            candidateResolver = boardResolver;
            candidateResolverCanDetect = boardResolverCanDetect;
          }
          compose(candidate.layout, candidateBoard, candidate);
        } catch (error) {
          applicationLog.error(configurationFailure(error));
          throw error;
        }
        if (stopped) throw new Error("Application is stopping.");
        // Hold delivery across asynchronous configuration changes so it cannot
        // combine a new target with a frame from partially configured plugins.
        ready = false;
        delivery.pause("Applying configuration");
        try {
          config = await store.save(input);
          saveError = undefined;
          await pause.configure(config.ha);
          if (stopped) return { ...store.getPublic(), delivery: "stopped" };
          await codex.configure(config.codex);
          water.configure(config.water);
          haBlocks.configure(config.haBlocks);
          await ha.configure(config.ha);
          if (targetChanged) {
            ready = false;
            await delivery.resetTarget();
            lastSuccessfulBase = undefined;
            lastSuccessfulBoard = undefined;
            board = candidateBoard;
            boardResolver = candidateResolver;
            boardResolverCanDetect = candidateResolverCanDetect;
          }
          delivery.setLimits(config.updateLimits);
          applicationLog.info(`Configuration applied for sections: ${configSections(input).join(", ")}.`);
        } catch (error) {
          saveError = "Could not apply saved settings. Check the configuration directory and try again.";
          applicationLog.error(configurationFailure(error));
          throw error;
        } finally { ready = !stopped; requestComposition(); flushPending(); }
        const pauseRelated = pauseOverlayChanged || haPauseChanged;
        if (pause.status().paused && !pauseRelated) return { ...store.getPublic(), delivery: "paused" as const };
        const attempt = pauseRelated ? await delivery.attempt() : await delivery.attemptManual();
        return { ...store.getPublic(), delivery: attempt.outcome };
      });
      saveQueue = task.catch(() => {});
      return await task;
    },
    pause: async (input) => {
      const task = pause.setManual(input.paused);
      requestComposition();
      try {
        await task;
        applicationLog.info(input.paused ? "Manual pause requested." : "Manual resume requested.");
      } finally {
        requestComposition();
      }
      flushPending();
      await delivery.attempt();
      return status();
    },
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
        const pausedAtStart = pause.status().paused;
        if (pausedAtStart) {
          delivery.pause("Waiting for initial collection.");
          await Promise.all([ha.collectInitial().catch(() => {}), codex.collectInitial()]);
          if (stopped) return;
        }
        ready = true;
        syncPause();
        if (!boardDetectionPending() && !pause.status().paused) {
          await delivery.deliverStartup(formatStartupMessage({ plugins: plugins.filter((plugin) => plugin.enabled), now: now(), board, transport: config.transport.localApiKey ? "local" : "cloud", timeZone: config.codex.timeZone }), 30_000);
        }
        if (stopped) return;
        requestComposition();
        flushPending();
        minute = setIntervalImpl(() => {
          retryBoardDetection();
          requestComposition();
        }, 60_000);
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
        const pausedAtStart = pause.status().paused;
        if (pausedAtStart) delivery.pause("Waiting for initial collection.");
        await Promise.all([ha.collectInitial().catch(() => {}), codex.collectInitial()]);
        if (stopped) return;
        ready = true;
        requestComposition();
        flushPending();
        return delivery.attempt();
      })();
      return onceTask;
    },
    stop() {
      if (stopTask) return stopTask;
      stopped = true;
      applicationLog.info("Stopping application.");
      clearIntervalImpl(minute);
      const stopDelivery = delivery.stop();
      water.stop();
      haBlocks.stop();
      const stopModules = Promise.all([codex.stop(), ha.stop()]);
      stopTask = (async () => {
        await Promise.all([startTask?.catch(() => {}), onceTask?.catch(() => {}), saveQueue, boardResolutionTask, stopModules]);
        await Promise.all([stopDelivery, pause.stop()]);
      })();
      return stopTask;
    }
  };
}

function configurationFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const sections = ["board", "ha", "water", "haBlocks", "haBlock", "transport", "codex", "layout", "pauseOverlay", "updateLimits", "updateIntervalMinutes"]
    .filter((section) => text.includes(section));
  return sections.length > 0
    ? `Configuration save failed for ${sections.join(", ")}.`
    : "Configuration save failed while validating or applying settings.";
}

function configSections(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["unknown"];
  const sections = Object.keys(input as Record<string, unknown>);
  return sections.length > 0 ? sections : ["none"];
}
