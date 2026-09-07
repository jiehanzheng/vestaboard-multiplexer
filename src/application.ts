import { ConfigStore, type AppConfig } from "./config.js";
import { composeElements, type LayoutEntry } from "./elements.js";
import { createCodexIntegration } from "./plugins/codexQuota/integration.js";
import { PauseStore } from "./pause.js";
import { composePauseOverlay } from "./pauseOverlay.js";
import { DeliveryController, type DeliveryAttempt } from "./runtime/delivery.js";
import type { RuntimeActions } from "./runtime/actions.js";
import { createVestaboardClient, type VestaboardMessage } from "./vestaboard.js";
import { createVestaboardBoardResolver, type VestaboardBoardResolver } from "./vestaboardBoard.js";
import { formatStartupMessage } from "./startupMessage.js";
import type { VestaboardBoard } from "./vestaboardTypes.js";
import type { PreviewRequest, RuntimeStatus } from "./contracts/api.js";
import type { ConfigSaveResponse } from "./contracts/config.js";
import { LogBuffer } from "./logger.js";

export interface ApplicationDependencies {
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

/** One engine owns collection, composition, pause, and delivery for CLI and daemon modes. */
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
  logs.setSecrets([config.transport.token, config.transport.localApiKey]);
  const makeBoard = dependencies.createVestaboardClient ?? createVestaboardClient;
  const pause = await PauseStore.open(directory);
  const codex = (dependencies.createCodexIntegration ?? createCodexIntegration)(config.codex, { changed: requestComposition, now, logger: logs.child("codex") });
  const delivery = new DeliveryController({
    intervalMs: config.updateIntervalMinutes * 60_000,
    now,
    logger: logs.child("delivery"),
    send: async (frame) => {
      const stateAtAttempt = pause.status();
      const boardAtAttempt = board;
      const baseAtAttempt = stateAtAttempt.paused && frozenBoard === boardAtAttempt && frozenBase ? structuredClone(frozenBase) : structuredClone(frame);
      try {
        await makeBoard({ dryRun, ...config.transport, logger: logs.child("vestaboard") }).send(frame);
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
  delivery.onStatusChange(() => changed());

  function dimensions(value = board) { return value === "note" ? { width: 15, height: 3 } : { width: 22, height: 6 }; }
  function defaultLayout(value = board): LayoutEntry[] { return codex.defaultLayout(value); }
  function elements(draft?: Pick<PreviewRequest, "codex">) { return codex.elements(draft?.codex); }
  function compose(layout: LayoutEntry[] | null = config.layout, value = board, draft?: Pick<PreviewRequest, "codex">) {
    return composeElements(elements(draft), layout ?? codex.defaultLayout(value, draft?.codex), dimensions(value), value);
  }
  function configurationError() { return store.getPublic().error ?? (!dryRun && !config.transport.token && !config.transport.localApiKey ? "Configure a board connection in config.json." : undefined); }
  function boardDetectionPending(): boolean { return boardResolverCanDetect && boardResolver?.resolution().source === "assumed"; }
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
  function requestComposition() {
    if (!ready || stopped) return;
    const state = pause.status();
    const userPaused = state.manualPause;
    try {
      if (userPaused) {
        if (!frozenBase || frozenBoard !== board) {
          const sent = lastSuccessfulBoard === board && frameMatchesBoard(lastSuccessfulBase, board) ? lastSuccessfulBase : delivery.lastSent();
          const current = delivery.currentFrame();
          frozenBase = frameMatchesBoard(sent, board) ? sent : frameMatchesBoard(current, board) ? current : compose();
          frozenBoard = board;
        }
        delivery.updateFrame(composePauseOverlay(frozenBase, config.pauseOverlay, board));
      } else {
        frozenBase = undefined;
        frozenBoard = undefined;
        delivery.updateFrame(compose());
      }
      renderError = undefined;
    }
    catch (error) { renderError = error instanceof Error ? error.message : "Unable to render layout"; delivery.clearFrame(); }
    syncPause();
    changed();
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
    const resolved = await resolveBoard(config);
    board = resolved.board;
    boardResolver = resolved.resolver;
    boardResolverCanDetect = resolved.canDetect;
    if (stopped) return;
  }
  function status(): RuntimeStatus {
    const pauseState = pause.status();
    return {
      board, dryRun, desired: delivery.currentFrame(), lastSent: delivery.lastSent(), pauseBackground: pauseState.manualPause ? frozenBase : undefined, nextAttemptAt: delivery.status().nextAttemptAt?.getTime() ?? 0,
      lastSentAt: delivery.status().lastSuccessfulAt?.getTime(), manualPause: pauseState.manualPause, paused: delivery.status().paused || pauseState.paused,
      pauseReason: delivery.status().pauseReason ?? pauseState.pauseReason, persistenceError: pauseState.persistenceError ?? saveError, configError: configurationError() ?? renderError,
      deliveryError, codex: codex.status()
    };
  }
  const actions: RuntimeActions = {
    status,
    config: () => store.getPublic(),
    elements: () => ({
      elements: elements().map((element) => ({ id: element.id, label: element.label, height: element.height, ...(element.minWidth === undefined ? {} : { minWidth: element.minWidth }), preview: element.render(dimensions().width) })),
      defaultLayout: defaultLayout(),
      defaultLayouts: { note: defaultLayout("note"), flagship: defaultLayout("flagship") }
    }),
    preview: (input) => compose(input.layout, input.board === "note" || input.board === "flagship" ? input.board : board, input),
    save: async (input): Promise<ConfigSaveResponse> => {
      const task = saveQueue.then(async () => {
        if (stopped) throw new Error("Application is stopping.");
        await startTask;
        if (stopped) throw new Error("Application is stopping.");
        let candidate: AppConfig;
        try { candidate = store.preview(input); }
        catch (error) { applicationLog.error(configurationFailure(error)); throw error; }
        const pauseOverlayChanged = input.pauseOverlay !== undefined && JSON.stringify(input.pauseOverlay) !== JSON.stringify(config.pauseOverlay);
        logs.setSecrets([config.transport.token, config.transport.localApiKey, candidate.transport.token, candidate.transport.localApiKey]);
        const targetChanged = JSON.stringify(config.transport) !== JSON.stringify(candidate.transport) || config.board !== candidate.board;
        let candidateBoard: VestaboardBoard;
        let candidateResolver: VestaboardBoardResolver | undefined;
        let candidateResolverCanDetect = false;
        if (targetChanged) {
          const resolved = await resolveBoard(candidate);
          candidateBoard = resolved.board; candidateResolver = resolved.resolver; candidateResolverCanDetect = resolved.canDetect;
        } else { candidateBoard = board; candidateResolver = boardResolver; candidateResolverCanDetect = boardResolverCanDetect; }
        compose(candidate.layout, candidateBoard, candidate);
        if (stopped) throw new Error("Application is stopping.");
        ready = false;
        delivery.pause("Applying configuration");
        try {
          config = await store.save(input);
          saveError = undefined;
          if (stopped) return { ...store.getPublic(), delivery: "stopped" as const };
          await codex.configure(config.codex);
          if (targetChanged) { ready = false; await delivery.resetTarget(); lastSuccessfulBase = undefined; lastSuccessfulBoard = undefined; board = candidateBoard; boardResolver = candidateResolver; boardResolverCanDetect = candidateResolverCanDetect; }
          delivery.setInterval(config.updateIntervalMinutes * 60_000);
          applicationLog.info(`Configuration applied for sections: ${configSections(input).join(", ")}.`);
        } catch (error) {
          saveError = "Could not apply saved settings. Check the configuration directory and credentials.";
          applicationLog.error(configurationFailure(error));
          throw error;
        } finally { ready = !stopped; requestComposition(); }
        if (pause.status().paused && !pauseOverlayChanged) return { ...store.getPublic(), delivery: "paused" as const };
        const attempt = pauseOverlayChanged ? await delivery.attempt() : await delivery.attemptManual();
        return { ...store.getPublic(), delivery: attempt.outcome };
      });
      saveQueue = task.catch(() => {});
      return task;
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
        await delivery.attempt();
        return status();
      }
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
        codex.start();
        const pausedAtStart = pause.status().paused;
        if (pausedAtStart) {
          delivery.pause("Waiting for initial collection.");
          await codex.collectInitial();
          if (stopped) return;
        }
        ready = true;
        syncPause();
        if (!boardDetectionPending() && !pause.status().paused) await delivery.deliverStartup(formatStartupMessage({ plugins: [codex], now: now(), board, transport: config.transport.localApiKey ? "local" : "cloud", timeZone: config.codex.timeZone }), 30_000);
        if (stopped) return;
        requestComposition();
        minute = setIntervalImpl(() => { retryBoardDetection(); requestComposition(); }, 60_000);
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
        const pausedAtStart = pause.status().paused;
        if (pausedAtStart) delivery.pause("Waiting for initial collection.");
        await codex.collectInitial();
        if (stopped) return;
        ready = true;
        requestComposition();
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
      stopTask = (async () => { await Promise.all([startTask?.catch(() => {}), onceTask?.catch(() => {}), saveQueue, boardResolutionTask, codex.stop()]); await Promise.all([stopDelivery, pause.flush()]); })();
      return stopTask;
    }
  };
}

function configurationFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const sections = ["board", "transport", "codex", "layout", "pauseOverlay", "updateIntervalMinutes"]
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
