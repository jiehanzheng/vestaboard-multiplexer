import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CSSProperties } from "react";
import type { AppConfig, DeliveryOutcome } from "../../src/contracts/config";
import {
  getConfig,
  getElements,
  getStatus,
  getHomeAssistantEntities,
  requestPreview,
  saveConfig,
  setPause,
  subscribeToEvents
} from "./api";
import { PluginsScreen, SettingsScreen, type PluginView } from "./ConnectionsScreen";
import { LogsScreen } from "./LogsScreen";
import { LegacyEnvironmentWarning } from "./LegacyEnvironmentWarning";
import { configPatchForSection, replaceSection, reconcileSectionSave, sectionIsDirty, type ConfigSection } from "./draftState";
import type {
  BoardMessage,
  BoardElement,
  BoardKind,
  ConfigResponse,
  ElementsResponse,
  LayoutEntry,
  LoginStatus,
  PreviewMode,
  RuntimeStatus
} from "./types";
import type { EntityCatalogState } from "./types";
import type { LogsResponse } from "../../src/contracts/logs.js";
import { waterElementIssue, type WaterHeaterStatus } from "../../src/plugins/waterHeater/status.js";
import {
  cloneConfig,
  formatDate,
  getBoardMatrix,
  relativeTime,
  pauseReason,
} from "./utils";
import { BOARD_DIMENSIONS, elementById, firstFreeRectangle, layoutEntryStartColumn, layoutEntryWidth, layoutRange, sortLayoutIndexes, validateLayout } from "./layoutUtils";
import { createLatestPreviewQueue } from "./previewScheduler";
import type { Notice, NoticeTone } from "./notice";
import { BoardCell } from "./BoardCell";
import { BoardSurface } from "./BoardSurface";

type View = "board" | "plugins" | "settings";

function saveDeliveryFeedback(delivery: DeliveryOutcome, dryRun: boolean | undefined, savedLabel: string): { message: string; tone?: NoticeTone } {
  switch (delivery) {
    case "sent": return { message: `Saved ${savedLabel}; ${dryRun === true ? "preview simulated." : "board updated."}` };
    case "unchanged": return { message: `Saved ${savedLabel}; output is already current${dryRun === true ? " (preview simulated)." : "."}` };
    case "failed": return { tone: "warning", message: `Saved ${savedLabel}; board update failed. Retry on the next eligible attempt.` };
    case "paused": return { message: `Saved ${savedLabel}; updates are paused.` };
    case "limited": return { message: `Saved ${savedLabel}; update waits for startup banner.` };
    case "empty": return { message: `Saved ${savedLabel}; no eligible board output was available.` };
    case "stopped": return { message: `Saved ${savedLabel}; the app is stopping before it can update the board.` };
  }
}

interface RouteState {
  view: View;
  plugin?: PluginView;
  settingsSubview: "main" | "logs";
  logsSource?: string;
}

function routeFromHash(hash: string): RouteState {
  const value = hash.replace(/^#/, "") || "board";
  const [path, query] = value.split("?", 2);
  const source = new URLSearchParams(query ?? "").get("source") ?? undefined;
  if (path === "plugins/codex") return { view: "plugins", plugin: "codex", settingsSubview: "main" };
  if (path === "plugins/water") return { view: "plugins", plugin: "water", settingsSubview: "main" };
  if (path === "plugins") return { view: "plugins", settingsSubview: "main" };
  if (path === "settings/logs") return { view: "settings", settingsSubview: "logs", logsSource: source };
  if (path === "settings") return { view: "settings", settingsSubview: "main" };
  return { view: "board", settingsSubview: "main" };
}

function routeToHash(route: RouteState): string {
  if (route.view === "plugins") return route.plugin ? `#plugins/${route.plugin}` : "#plugins";
  if (route.view === "settings") {
    if (route.settingsSubview === "logs") {
      const query = route.logsSource ? `?source=${encodeURIComponent(route.logsSource)}` : "";
      return `#settings/logs${query}`;
    }
    return "#settings";
  }
  return "#board";
}

export default function App(): ReactNode {
  const [route, setRoute] = useState<RouteState>(() => routeFromHash(window.location.hash));
  const { view, plugin: pluginView, settingsSubview, logsSource } = route;
  const [logs, setLogs] = useState<LogsResponse["entries"]>([]);
  const [status, setStatus] = useState<RuntimeStatus>();
  const [configResponse, setConfigResponse] = useState<ConfigResponse>();
  const [elementsResponse, setElementsResponse] = useState<ElementsResponse>();
  const [draftConfig, setDraftConfig] = useState<AppConfig>();
  const [selectedEntryIndex, setSelectedEntryIndex] = useState<number>();
  const [previewMode, setPreviewMode] = useState<PreviewMode>("desired");
  const [draftPreview, setDraftPreview] = useState<BoardMessage>();
  const [previewError, setPreviewError] = useState<string>();
  const [previewPending, setPreviewPending] = useState(false);
  const [events, setEvents] = useState<{ connected: boolean; error?: string }>({ connected: false, error: "Connecting to live updates…" });
  const [notice, setNotice] = useState<Notice>();
  const [loadError, setLoadError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [entityCatalog, setEntityCatalog] = useState<EntityCatalogState>({ items: [], loading: false });
  const loadedOnce = useRef(false);
  const draftConfigRef = useRef<AppConfig | undefined>(undefined);
  const entityRequestRevisionRef = useRef(0);
  const entitySourceKeyRef = useRef("");
  const previewPayloadRevisionRef = useRef(0);
  const previewPayloadKeyRef = useRef<string | undefined>(undefined);
  const previewQueueRef = useRef<ReturnType<typeof createLatestPreviewQueue<BoardMessage>> | undefined>(undefined);
  if (!previewQueueRef.current) previewQueueRef.current = createLatestPreviewQueue<BoardMessage>();
  const [savingSection, setSavingSection] = useState<ConfigSection>();
  const savingSectionRef = useRef<ConfigSection | undefined>(undefined);

  useEffect(() => {
    const onHashChange = (): void => {
      setRoute(routeFromHash(window.location.hash));
    };
    const currentRoute = routeFromHash(window.location.hash);
    const expectedHash = routeToHash(currentRoute);
    if (window.location.hash !== expectedHash) window.history.replaceState(null, "", expectedHash);
    setRoute(currentRoute);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = useCallback((route: RouteState): void => {
    const hash = routeToHash(route);
    if (window.location.hash === hash) return;
    window.location.hash = hash.slice(1);
  }, []);

  const openPlugin = useCallback((nextPlugin: PluginView | undefined): void => {
    navigate({ view: "plugins", plugin: nextPlugin, settingsSubview: "main" });
  }, [navigate]);
  const openView = useCallback((nextView: View): void => {
    navigate({ view: nextView, settingsSubview: "main" });
  }, [navigate]);
  const openLogs = useCallback((source?: string): void => {
    navigate({ view: "settings", settingsSubview: "logs", logsSource: source });
  }, [navigate]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([getConfig(), getElements(), getStatus()])
      .then(([nextConfig, nextElements, nextStatus]) => {
        if (!active) return;
        setConfigResponse(nextConfig);
        setElementsResponse(nextElements);
        setStatus(nextStatus);
        setDraftConfig(cloneConfig(nextConfig.config));
        draftConfigRef.current = cloneConfig(nextConfig.config);
        setLoadError(nextConfig.error);
        loadedOnce.current = true;
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : "Could not load vbmux.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => subscribeToEvents(
    (nextStatus) => setStatus(nextStatus),
    (connected, error) => setEvents({ connected, error }),
    (nextLogs) => setLogs(nextLogs.entries)
  ), []);

  const refreshEntities = useCallback(async () => {
    const requestRevision = entityRequestRevisionRef.current + 1;
    entityRequestRevisionRef.current = requestRevision;
    const savedHa = configResponse?.config.ha;
    if (draftConfig && configResponse && sectionIsDirty("ha", draftConfig, configResponse.config)) {
      setEntityCatalog({ items: [], loading: false, error: "Save Home Assistant connection first to refresh entities." });
      return;
    }
    const ha = savedHa;
    if (!ha?.url.trim()) {
      setEntityCatalog({ items: [], loading: false, error: "Save a Home Assistant URL first." });
      return;
    }
    const sourceKey = ha.url;
    setEntityCatalog((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const response = await getHomeAssistantEntities({ url: ha.url });
      if (entityRequestRevisionRef.current === requestRevision && entitySourceKeyRef.current === sourceKey) {
        setEntityCatalog({ items: response.entities, loading: false, loadedAt: Date.now() });
      }
    } catch (error: unknown) {
      if (entityRequestRevisionRef.current === requestRevision && entitySourceKeyRef.current === sourceKey) {
        setEntityCatalog((current) => ({ ...current, loading: false, error: error instanceof Error ? error.message : "Could not load Home Assistant entities." }));
      }
    }
  }, [configResponse, draftConfig]);

  const entitySourceKey = configResponse?.config.ha.url ?? "";
  useEffect(() => {
    if (entitySourceKeyRef.current && entitySourceKeyRef.current !== entitySourceKey) {
      entityRequestRevisionRef.current += 1;
      setEntityCatalog({ items: [], loading: false });
    }
    entitySourceKeyRef.current = entitySourceKey;
  }, [entitySourceKey]);

  const entityCatalogSource = configResponse?.config.ha.url.trim() ?? "";
  const catalogLoadedSourceRef = useRef("");
  useEffect(() => {
    if (!entityCatalogSource || !configResponse || !draftConfig || sectionIsDirty("ha", draftConfig, configResponse.config)) return;
    if (catalogLoadedSourceRef.current === entityCatalogSource) return;
    catalogLoadedSourceRef.current = entityCatalogSource;
    void refreshEntities();
  }, [configResponse, draftConfig, entityCatalogSource, refreshEntities]);

  const boardPreference = draftConfig?.board ?? "auto";
  const board = boardPreference === "auto" ? (status?.board ?? "note") : boardPreference;
  const elements = elementsResponse?.elements ?? [];
  const defaultLayout = elementsResponse?.defaultLayouts?.[board] ?? elementsResponse?.defaultLayout ?? [];
  const draftLayout = draftConfig?.layout ?? defaultLayout;
  const layoutError = validateLayout(draftLayout, elements, board);
  useEffect(() => {
    if (draftLayout.length === 0) {
      if (selectedEntryIndex !== undefined) setSelectedEntryIndex(undefined);
      return;
    }
    if (selectedEntryIndex !== undefined && selectedEntryIndex < draftLayout.length) return;
    const first = sortLayoutIndexes(draftLayout)[0];
    if (first !== undefined) setSelectedEntryIndex(first);
  }, [board, draftLayout, selectedEntryIndex]);
  const isDirty = useMemo(() => {
    if (!draftConfig || !configResponse) return Boolean(draftConfig);
    return JSON.stringify(draftConfig) !== JSON.stringify(configResponse.config);
  }, [configResponse, draftConfig]);
  const layoutPreview = layoutError ? undefined : isDirty ? draftPreview : status?.desired;
  const waterStatus = status?.water as WaterHeaterStatus | undefined;

  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  useEffect(() => {
    if (!loadedOnce.current || !elementsResponse || layoutError || !isDirty) {
      previewPayloadRevisionRef.current += 1;
      previewPayloadKeyRef.current = undefined;
      previewQueueRef.current?.cancel();
      setDraftPreview(undefined);
      setPreviewError(layoutError);
      setPreviewPending(false);
      return;
    }
    const payload = {
      layout: draftLayout,
      board: boardPreference,
      water: draftConfig?.water,
      codex: draftConfig?.codex
    };
    const payloadKey = JSON.stringify(payload);
    const payloadChanged = previewPayloadKeyRef.current !== payloadKey;
    if (payloadChanged) {
      previewPayloadKeyRef.current = payloadKey;
      previewPayloadRevisionRef.current += 1;
    }
    const payloadRevision = previewPayloadRevisionRef.current;
    setPreviewError(undefined);
    // Keep status live for unsaved bindings, but background refreshes do not reopen the busy state.
    if (payloadChanged) setPreviewPending(true);
    previewQueueRef.current?.schedule({
      task: () => requestPreview(payload.layout, payload.board, payload.water, payload.codex),
      onSuccess: (nextPreview) => {
        if (previewPayloadRevisionRef.current !== payloadRevision) return;
        setDraftPreview(nextPreview);
        setPreviewError(undefined);
        setPreviewPending(false);
      },
      onError: (error: unknown) => {
        if (previewPayloadRevisionRef.current !== payloadRevision) return;
        setPreviewError(error instanceof Error ? error.message : "Could not preview this layout.");
        setPreviewPending(false);
      },
      onSettled: () => {
        if (previewPayloadRevisionRef.current === payloadRevision && !previewQueueRef.current?.isPending()) setPreviewPending(false);
      }
    });
  }, [boardPreference, draftConfig, draftLayout, elementsResponse, isDirty, layoutError, status]);

  useEffect(() => () => {
    previewQueueRef.current?.cancel();
    previewPayloadRevisionRef.current += 1;
  }, []);

  const updateDraftConfig = useCallback((next: AppConfig) => {
    draftConfigRef.current = next;
    setDraftConfig(next);
    setNotice(undefined);
  }, []);

  const updateDraftLayout = useCallback((next: LayoutEntry[]) => {
    setDraftConfig((current) => {
      if (!current) return current;
      const updated = { ...current, layout: next };
      draftConfigRef.current = updated;
      return updated;
    });
    setNotice(undefined);
  }, []);

  const sectionDirty = useCallback((section: ConfigSection): boolean => {
    return Boolean(draftConfig && configResponse && sectionIsDirty(section, draftConfig, configResponse.config));
  }, [configResponse, draftConfig]);

  const saveSection = useCallback((section: ConfigSection): Promise<void> => {
    if (savingSectionRef.current) return Promise.resolve();
    const submittedDraft = draftConfigRef.current;
    const run = async (): Promise<void> => {
      if (!submittedDraft || !configResponse) return;
      if (section === "layout" && layoutError) {
        setNotice({ tone: "error", section, message: layoutError });
        return;
      }
      savingSectionRef.current = section;
      setSavingSection(section);
      setNotice(undefined);
      const submitted = cloneConfig(submittedDraft);
      try {
        const response = await saveConfig(configPatchForSection(section, submitted));
        setConfigResponse(response);
        const currentDraft = draftConfigRef.current ?? submitted;
        const reconciled = reconcileSectionSave({ section, acknowledgement: response, submittedDraft: submitted, currentDraft });
        draftConfigRef.current = reconciled.draftConfig;
        setDraftConfig(reconciled.draftConfig);
        let elementsRefreshed = true;
        try { setElementsResponse(await getElements()); } catch { elementsRefreshed = false; }
        const savedLabel = section === "layout" ? "layout" : section === "ha" ? "Home Assistant" : section === "pause" ? "pause settings" : section === "water" ? "water heater" : section === "board" ? "board settings" : "Codex";
        const delivery = saveDeliveryFeedback(response.delivery, status?.dryRun, savedLabel);
        const refreshSuffix = elementsRefreshed ? "" : " Board elements could not be refreshed yet.";
        const newerSuffix = reconciled.newerEdits ? " Newer edits remain unsaved." : "";
        setNotice({ tone: delivery.tone ?? (reconciled.newerEdits || !elementsRefreshed ? "info" : "success"), section, message: `${delivery.message}${refreshSuffix}${newerSuffix}` });
      } catch (error: unknown) {
        setNotice({ tone: "error", section, message: error instanceof Error ? error.message : `Could not save ${section} settings.` });
      } finally {
        savingSectionRef.current = undefined;
        setSavingSection(undefined);
      }
    };
    return run();
  }, [configResponse, layoutError, status]);

  const discardSection = useCallback((section: ConfigSection): void => {
    if (!configResponse || !draftConfig) return;
    const nextDraft = replaceSection(draftConfig, configResponse.config, section);
    draftConfigRef.current = nextDraft;
    setDraftConfig(nextDraft);
    setNotice({ tone: "info", section, message: `${section === "layout" ? "Layout" : section === "ha" ? "Home Assistant" : section === "pause" ? "Pause settings" : section === "water" ? "Water heater" : section === "board" ? "Board settings" : "Codex"} draft discarded.` });
  }, [configResponse, draftConfig]);

  const handlePause = useCallback(async () => {
    if (!status) return;
    try {
      await setPause(!status.manualPause);
      const nextStatus = await getStatus();
      setStatus(nextStatus);
      setNotice({ tone: "success", section: "runtime", message: nextStatus.manualPause ? "Updates paused." : nextStatus.haPause ? "Manual pause cleared; Home Assistant still holds updates." : "Updates resumed." });
    } catch (error: unknown) {
      setNotice({ tone: "error", section: "runtime", message: error instanceof Error ? error.message : "Could not change pause state." });
    }
  }, [status]);

  if (loading) {
    return <div className="loading-shell" role="status">Loading vbmux…</div>;
  }

  if (loadError && !status && !configResponse) {
    return <ErrorScreen message={loadError} onRetry={() => window.location.reload()} />;
  }

  const login = status?.login ?? { pending: false };

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="wordmark" href="#board" onClick={(event) => { event.preventDefault(); openView("board"); }}>vbmux</a>
        <nav className="top-nav" aria-label="Primary">
          <button className={view === "board" ? "nav-tab active" : "nav-tab"} onClick={() => openView("board")} aria-current={view === "board" ? "page" : undefined}>Board</button>
          <button className={view === "plugins" ? "nav-tab active" : "nav-tab"} onClick={() => openView("plugins")} aria-current={view === "plugins" ? "page" : undefined}>Plugins</button>
          <button className={view === "settings" ? "nav-tab active" : "nav-tab"} onClick={() => openView("settings")} aria-current={view === "settings" ? "page" : undefined}>Settings</button>
        </nav>
        <div className={events.connected ? "live-status is-live" : "live-status"} role="status">
          <span className="status-dot" aria-hidden="true" />
          <span>{events.connected ? "Status live" : "Status reconnecting"}</span>
          {events.error ? <span className="live-error" role="status">{events.error}</span> : null}
        </div>
      </header>

      <main className="page-shell">
        <LegacyEnvironmentWarning names={configResponse?.legacyEnvironmentVariables ?? []} />
        {view === "board" ? (
          <BoardScreen
            board={board}
            boardPreference={boardPreference}
            status={status}
            elements={elements}
            draftLayout={draftLayout}
            selectedEntryIndex={selectedEntryIndex}
            setSelectedEntryIndex={setSelectedEntryIndex}
            setDraftLayout={updateDraftLayout}
            previewMode={previewMode}
            setPreviewMode={setPreviewMode}
            preview={previewMode === "desired" && isDirty && draftPreview ? draftPreview : previewMode === "desired" ? status?.desired : status?.lastSent}
            layoutPreview={layoutPreview}
            previewPending={previewPending}
            previewError={previewError}
            onPause={handlePause}
            onApply={() => void saveSection("layout")}
            onDiscard={() => discardSection("layout")}
            saving={savingSection === "layout"}
            savingAny={Boolean(savingSection)}
            dirty={sectionDirty("layout")}
            layoutError={layoutError}
            notice={notice?.section === "layout" || notice?.section === "runtime" ? notice : undefined}
            waterStatus={waterStatus}
            onOpenWaterSettings={() => openPlugin("water")}
          />
        ) : view === "plugins" && draftConfig ? (
          <PluginsScreen
            login={login}
            plugin={pluginView}
            onPluginChange={openPlugin}
            status={status}
            config={draftConfig}
            configResponse={configResponse}
            dirty={sectionDirty}
            saving={savingSection}
            notice={notice}
            onSave={(section) => void saveSection(section)}
            onDiscard={discardSection}
            entities={entityCatalog.items}
            entitiesLoading={entityCatalog.loading}
            entitiesError={entityCatalog.error}
            onRefreshEntities={() => void refreshEntities()}
            onConfigChange={updateDraftConfig}
            onLogin={(nextLogin) => setStatus((current) => current ? { ...current, login: nextLogin } : current)}
            onNotice={setNotice}
            onOpenSettings={() => openView("settings")}
            onOpenLogs={openLogs}
          />
        ) : draftConfig && view === "settings" && settingsSubview === "logs" ? <LogsScreen
          entries={logs}
          source={logsSource}
          connected={events.connected}
          onBack={() => openView("settings")}
        /> : draftConfig ? <SettingsScreen
          status={status}
          config={draftConfig}
          configResponse={configResponse}
          dirty={sectionDirty}
            saving={savingSection}
            notice={notice}
          onSave={(section) => void saveSection(section)}
          onDiscard={discardSection}
          entities={entityCatalog.items}
          entitiesLoading={entityCatalog.loading}
          entitiesError={entityCatalog.error}
          onRefreshEntities={() => void refreshEntities()}
          onConfigChange={updateDraftConfig}
          onLogin={(nextLogin) => setStatus((current) => current ? { ...current, login: nextLogin } : current)}
          onNotice={setNotice}
          onOpenSettings={() => openView("settings")}
          onOpenLogs={openLogs}
        /> : null}
      </main>
    </div>
  );
}

interface BoardScreenProps {
  board: BoardKind;
  boardPreference: "auto" | BoardKind;
  status: RuntimeStatus | undefined;
  elements: BoardElement[];
  draftLayout: LayoutEntry[];
  selectedEntryIndex: number | undefined;
  setSelectedEntryIndex: (index: number | undefined) => void;
  setDraftLayout: (layout: LayoutEntry[]) => void;
  previewMode: PreviewMode;
  setPreviewMode: (mode: PreviewMode) => void;
  preview: BoardMessage | undefined;
  layoutPreview: BoardMessage | undefined;
  previewPending: boolean;
  previewError: string | undefined;
  onPause: () => void;
  onApply: () => void;
  onDiscard: () => void;
  saving: boolean;
  savingAny: boolean;
  dirty: boolean;
  layoutError: string | undefined;
  notice: Notice;
  waterStatus: WaterHeaterStatus | undefined;
  onOpenWaterSettings: () => void;
}

function BoardScreen(props: BoardScreenProps): ReactNode {
  const {
    board, boardPreference, status, elements, draftLayout, selectedEntryIndex, setSelectedEntryIndex, setDraftLayout,
    previewMode, setPreviewMode, preview, layoutPreview, previewPending, previewError,
    onPause, onApply, onDiscard, saving, savingAny, dirty, layoutError, notice, waterStatus, onOpenWaterSettings
  } = props;
  const selectedEntry = selectedEntryIndex !== undefined ? draftLayout[selectedEntryIndex] : undefined;
  const selectedElement = selectedEntry ? elementById(elements, selectedEntry.elementId) : undefined;
  const dimensions = BOARD_DIMENSIONS[board];
  const dryRun = status?.dryRun;
  const contentPaused = Boolean(status?.manualPause || status?.haPause);
  const deliveryHeld = Boolean(status?.paused && !contentPaused);
  const currentPauseReason = status ? pauseReason(status) : "";
  const outputLabel = dryRun === true ? "Dry run" : dryRun === false ? "Board delivery" : "Checking output mode";
  const outputDetail = dryRun === true ? "Physical board writes disabled" : dryRun === false ? "Physical board writes enabled" : "Output mode is being checked";
  const sentLabel = dryRun === true ? "Last simulated" : "Last sent";
  const updateSelectedEntry = (patch: Partial<LayoutEntry>): void => {
    if (!selectedEntry || selectedEntryIndex === undefined) return;
    const nextEntry = { ...selectedEntry, ...patch };
    setDraftLayout(draftLayout.map((entry, index) => index === selectedEntryIndex ? nextEntry : entry));
  };

  return (
    <>
      <div className="page-heading board-heading">
        <div>
          <h1>Your board</h1>
          <p>{dirty ? layoutError ? "You have unsaved layout changes." : "Draft changes are previewing. Apply layout to save them." : status?.lastSentAt ? `${sentLabel} ${relativeTime(status.lastSentAt).toLowerCase()}` : `${sentLabel}: no frame sent yet`}</p>
        </div>
        <button className="button secondary pause-button" onClick={onPause} disabled={!status}>
          <span aria-hidden="true">{status?.manualPause ? "▶" : "Ⅱ"}</span>
          {status?.manualPause ? "Resume manual pause" : "Pause manually"}
        </button>
      </div>
      <div className="output-status" role="status" aria-label="Board delivery summary">
        <OutputStatusItem label={outputLabel} detail={outputDetail} />
        <OutputStatusItem label={dirty ? "Draft layout" : "Saved layout"} detail={dirty ? "Unsaved changes" : "Matches saved settings"} />
        <OutputStatusItem label={status?.lastSentAt ? sentLabel : "Last output"} detail={status?.lastSentAt ? relativeTime(status.lastSentAt) : "No output yet"} />
        <OutputStatusItem label={contentPaused ? "Content paused" : deliveryHeld ? "Delivery held" : "Next attempt"} detail={contentPaused ? `${currentPauseReason}${status?.pauseBackground ? status.nextAttemptAt ? ` · overlay next ${formatDate(status.nextAttemptAt)}` : " · overlay follows normal cadence" : ""}` : deliveryHeld ? currentPauseReason : status?.nextAttemptAt ? formatDate(status.nextAttemptAt) : "Ready"} warning={deliveryHeld} />
      </div>

      <div className="board-workspace">
        <section className="board-stage" aria-label="Board preview">
          {previewMode === "lastSent" && !preview ? <div className="empty-output" role="status"><h2>No frame sent yet</h2><p>This process has not successfully delivered a frame. Select Desired to see the pending content.</p></div> : <BoardPreview
            board={board}
            message={preview}
            selectedEntry={selectedEntry}
            layout={draftLayout}
            elements={elements}
            selectedEntryIndex={selectedEntryIndex}
            onSelectEntry={setSelectedEntryIndex}
          />}
          <div className="board-meta-row">
            <div className="segmented-control" role="group" aria-label="Board message version">
              <button className={previewMode === "desired" ? "selected" : ""} aria-pressed={previewMode === "desired"} onClick={() => setPreviewMode("desired")}>Desired</button>
              <button className={previewMode === "lastSent" ? "selected" : ""} aria-pressed={previewMode === "lastSent"} onClick={() => setPreviewMode("lastSent")}>{sentLabel}</button>
            </div>
            <div className="board-facts">
              {previewPending ? <span>Updating preview…</span> : null}
              {deliveryHeld ? <span className="fact-warning">{currentPauseReason}</span> : null}
            </div>
          </div>
          <div className="message-caption">
            <span>{previewMode === "desired" ? (dirty ? "Draft message" : "Desired message") : `${sentLabel} message`}</span>
            <code>{preview?.text ?? (previewMode === "lastSent" ? "No frame sent yet" : "No preview available")}</code>
          </div>
          <RuntimeMessages status={status} />
        </section>

        <aside className="editor-panel" aria-label="Board editor">
          <div className="editor-title-row">
            <h2>Layout</h2>
            <span className="board-size">{board === "note" ? "Note · 3 × 15" : "Flagship · 6 × 22"}</span>
          </div>
          <LayoutEditor
            board={board}
            elements={elements}
            layout={draftLayout}
            selectedEntryIndex={selectedEntryIndex}
            onSelectEntry={setSelectedEntryIndex}
            onChange={setDraftLayout}
          />
          {selectedEntry && selectedElement ? <SelectedLayoutFields entry={selectedEntry} element={selectedElement} board={board} elements={elements} onChange={updateSelectedEntry} /> : null}
          <div className="editor-preview-block">
            <div className="subheading-row">
              <h3>{selectedElement ? `${selectedElement.label} preview` : "Layout preview"}</h3>
              {selectedElement && selectedEntry ? <span className="height-label">{selectedElement.height} row{selectedElement.height === 1 ? "" : "s"}</span> : null}
            </div>
            <MiniPreview element={selectedElement} entry={selectedEntry} board={board} message={layoutPreview} />
            {selectedElement && selectedElement.id.startsWith("water.") ? <WaterLayoutNotice issue={waterStatus ? waterElementIssue(selectedElement.id, waterStatus) : "Water heater status is not available. Open Water Heater settings to check it."} onOpenSettings={onOpenWaterSettings} /> : null}
          </div>
          <div className="editor-actions">
            <button className="button secondary" onClick={onDiscard} disabled={!dirty || savingAny}>Discard layout</button>
            <button className="button primary" onClick={onApply} disabled={!dirty || savingAny || Boolean(layoutError)}>{saving ? "Saving…" : "Apply layout"}</button>
          </div>
          {layoutError ? <p className="inline-message error" role="alert">{layoutError}</p> : null}
          {previewError && !layoutError ? <p className="inline-message error" role="alert">{previewError}</p> : null}
          {notice ? <p className={`inline-message ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p> : null}
        </aside>
      </div>

    </>
  );
}

function OutputStatusItem({ label, detail, warning = false }: { label: string; detail: string; warning?: boolean }): ReactNode {
  return <div className={warning ? "output-status-item warning" : "output-status-item"}><strong>{label}</strong><span>{detail}</span></div>;
}

function WaterLayoutNotice({ issue, onOpenSettings }: { issue: string | undefined; onOpenSettings: () => void }): ReactNode {
  if (!issue) return null;
  return <p className="inline-message info">Saved Water Heater settings: {issue} <button className="text-link" type="button" onClick={onOpenSettings}>Open Water Heater settings</button></p>;
}

interface BoardPreviewProps {
  board: BoardKind;
  message: BoardMessage | undefined;
  selectedEntry: LayoutEntry | undefined;
  layout: LayoutEntry[];
  elements: BoardElement[];
  selectedEntryIndex: number | undefined;
  onSelectEntry: (index: number | undefined) => void;
}

function BoardPreview({ board, message, selectedEntry, layout, elements, selectedEntryIndex, onSelectEntry }: BoardPreviewProps): ReactNode {
  const matrix = getBoardMatrix(message?.characters, board);
  const dimensions = BOARD_DIMENSIONS[board];
  return (
    <div className={`board-frame ${board}`}>
      <BoardSurface board={board} rows={matrix} className="vestaboard" rowLabel={(rowIndex) => `Board row ${rowIndex + 1}`} renderRow={(row, rowIndex) => {
          const segments = layout.map((entry, index) => {
            const element = elementById(elements, entry.elementId);
            if (!element || rowIndex < entry.startRow || rowIndex >= entry.startRow + element.height) return undefined;
            const rawStart = layoutEntryStartColumn(entry);
            const rawWidth = layoutEntryWidth(entry, board);
            if (!Number.isInteger(entry.startRow) || !Number.isInteger(rawStart) || !Number.isInteger(rawWidth) || rawWidth <= 0) return undefined;
            const start = Math.max(0, rawStart);
            const end = Math.min(dimensions.columns, rawStart + rawWidth);
            if (start >= end) return undefined;
            return { entry, element, index, start, end };
          }).filter((segment): segment is { entry: LayoutEntry; element: BoardElement; index: number; start: number; end: number } => Boolean(segment))
            .sort((left, right) => left.start - right.start || left.index - right.index);
          const cells: ReactNode[] = [];
          let cursor = 0;
          const renderCell = (code: number, columnIndex: number): ReactNode => (
            <BoardCell board={board} code={code} key={`cell-${rowIndex}-${columnIndex}`} ariaHidden />
          );
          segments.forEach(({ entry, element, index, start, end }) => {
            for (let columnIndex = cursor; columnIndex < start; columnIndex += 1) {
              cells.push(<span className="board-gap" style={{ gridColumn: `${columnIndex + 1}` }} key={`gap-${rowIndex}-${columnIndex}`}>{renderCell(row[columnIndex], columnIndex)}</span>);
            }
            const selected = selectedEntry && selectedEntryIndex === index;
            cells.push(
              <button
                className={`board-segment${selected ? " selected" : ""}`}
                style={{ gridColumn: `${start + 1} / span ${end - start}`, "--segment-columns": end - start } as CSSProperties}
                key={`segment-${rowIndex}-${index}-${start}-${end}`}
                aria-label={`Select ${elementLabel(element)}, ${layoutRange(entry, element, board)}`}
                onClick={() => onSelectEntry(index)}
              >
                {row.slice(start, end).map((code, columnIndex) => renderCell(code, start + columnIndex))}
              </button>
            );
            cursor = Math.max(cursor, end);
          });
          for (let columnIndex = cursor; columnIndex < dimensions.columns; columnIndex += 1) {
            cells.push(<span className="board-gap" style={{ gridColumn: `${columnIndex + 1}` }} key={`gap-${rowIndex}-${columnIndex}`}>{renderCell(row[columnIndex], columnIndex)}</span>);
          }
          return cells;
        }} />
    </div>
  );
}

interface LayoutEditorProps {
  board: BoardKind;
  elements: BoardElement[];
  layout: LayoutEntry[];
  selectedEntryIndex: number | undefined;
  onSelectEntry: (index: number | undefined) => void;
  onChange: (layout: LayoutEntry[]) => void;
}

function LayoutEditor({ board, elements, layout, selectedEntryIndex, onSelectEntry, onChange }: LayoutEditorProps): ReactNode {
  const sortedIndexes = sortLayoutIndexes(layout);
  return (
    <>
      <div className="picker-field layout-add-field">
        <label htmlFor="element-picker">Add content</label>
        <select id="element-picker" value="" onChange={(event) => {
          const next = firstFreeRectangle(layout, elements, board, event.target.value);
          if (next) { onChange([...layout, next]); onSelectEntry(layout.length); }
        }}>
          <option value="">Choose content</option>
          {elements.map((element) => {
            const available = firstFreeRectangle(layout, elements, board, element.id) !== undefined;
            return <option key={element.id} value={element.id} disabled={!available}>{element.label}{available ? "" : " (no room)"}</option>;
          })}
        </select>
      </div>
      {layout.length > 0 ? <div className="row-list" role="list" aria-label="Board layout">
      {sortedIndexes.map((index) => {
        const entry = layout[index];
        const element = elementById(elements, entry.elementId);
        const label = element?.label ?? `Row ${entry.startRow + 1}`;
        const range = element ? layoutEntrySummary(entry, element, elements, board) : "Unavailable range";
        return (
          <div className={selectedEntryIndex === index ? "row-item selected" : "row-item"} key={`${entry.elementId}-${index}`} role="listitem">
            <button className="row-main" onClick={() => onSelectEntry(index)} aria-label={`Edit ${label}, ${range}`}>
              <span className="row-number">{`Row ${entry.startRow + 1}`}</span>
              <span className="row-label"><strong>{label}</strong><small>{range}</small></span>
            </button>
            <div className="row-actions">
              <button className="icon-button danger" aria-label={`Remove ${label}`} onClick={() => {
                onChange(removeRow(layout, index));
                if (selectedEntryIndex === index) onSelectEntry(undefined);
                else if (selectedEntryIndex !== undefined && selectedEntryIndex > index) onSelectEntry(selectedEntryIndex - 1);
              }}>×</button>
            </div>
          </div>
        );
      })}
      </div> : <div className="empty-rows">No content is configured yet. Add content above.</div>}
    </>
  );
}

function MiniPreview({ element, entry, board, message }: { element: BoardElement | undefined; entry: LayoutEntry | undefined; board: BoardKind; message: BoardMessage | undefined }): ReactNode {
  if (!element) return <div className="mini-preview empty">Choose an element to preview it.</div>;
  if (entry && !message) return <div className="mini-preview empty">Preview unavailable until this placement is valid.</div>;
  const rawStart = entry ? layoutEntryStartColumn(entry) : 0;
  const rawWidth = entry ? layoutEntryWidth(entry, board) : element.preview[0]?.length ?? BOARD_DIMENSIONS[board].columns;
  const start = Number.isInteger(rawStart) ? Math.max(0, rawStart) : 0;
  const width = Number.isInteger(rawWidth) && rawWidth > 0 ? rawWidth : 0;
  const renderedRows = entry && message?.characters
    ? message.characters.slice(entry.startRow, entry.startRow + element.height)
    : undefined;
  const rows = renderedRows && renderedRows.length === element.height ? renderedRows : element.preview;
  const miniRow = rows.flatMap((row) => row.slice(start, start + width));
  return <BoardSurface
    board={board}
    rows={[miniRow]}
    columns={miniRow.length}
    className="mini-preview"
    ariaLabel={`${elementLabel(element)} preview`}
    renderRow={(row) => row.map((code, columnIndex) => <BoardCell board={board} code={code} className="mini-cell" key={columnIndex} ariaHidden />)}
  />;
}

function SelectedLayoutFields({ entry, element, board, elements, onChange }: { entry: LayoutEntry; element: BoardElement; board: BoardKind; elements: BoardElement[]; onChange: (patch: Partial<LayoutEntry>) => void }): ReactNode {
  const startColumn = layoutEntryStartColumn(entry);
  const width = layoutEntryWidth(entry, board);
  const dimensions = BOARD_DIMENSIONS[board];
  return <section className="layout-fields" aria-labelledby="selected-layout-heading">
    <h3 id="selected-layout-heading">Selected content</h3>
    <label className="config-field"><span>Content</span><select value={entry.elementId} onChange={(event) => onChange({ elementId: event.target.value })}>{elements.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
    <div className="settings-grid">
      <label className="config-field"><span>Row</span><input type="number" min={1} max={dimensions.rows} value={entry.startRow + 1} onChange={(event) => onChange({ startRow: Number(event.target.value) - 1 })} /></label>
      <label className="config-field"><span>Start character</span><input type="number" min={1} max={dimensions.columns} value={startColumn + 1} onChange={(event) => onChange({ startColumn: Number(event.target.value) - 1 })} /></label>
      <label className="config-field"><span>Width</span><input type="number" min={1} max={dimensions.columns - startColumn} value={width} onChange={(event) => onChange({ width: Number(event.target.value) })} /></label>
      <div className="config-field"><span>Height</span><output>{element.height} row{element.height === 1 ? "" : "s"}</output></div>
    </div>
    <p className="screen-footnote">{layoutEntrySummary(entry, element, elements, board)} · minimum width {element.minWidth ?? 1}</p>
  </section>;
}

function elementLabel(element: BoardElement | undefined): string {
  return element?.label ?? "Unavailable element";
}

function layoutEntrySummary(entry: LayoutEntry, element: BoardElement, elements: BoardElement[], board: BoardKind): string {
  return validateLayout([entry], elements, board) ? "Invalid placement" : layoutRange(entry, element, board);
}

function RuntimeMessages({ status }: { status: RuntimeStatus | undefined }): ReactNode {
  if (!status) return null;
  const messages = [
    status.deliveryError,
    status.configError,
    status.persistenceError,
    status.codex.stale ? "Codex readings are stale." : status.codex.error,
    status.homeAssistant?.error ? `Home Assistant: ${status.homeAssistant.error}` : undefined,
    status.water?.error ? `Water heater: ${status.water.error}` : undefined
  ].filter((value): value is string => Boolean(value));
  return messages.length > 0 ? (
    <div className="runtime-messages" role="alert">
      {messages.map((message) => <p key={message}>{message}</p>)}
    </div>
  ) : (
    <div className="runtime-reading">
      <span className="reading-dot" aria-hidden="true" />
      <span>Codex {status.codex.collectedAt ? `read ${relativeTime(status.codex.collectedAt).toLowerCase()}` : "reading unavailable"}</span>
    </div>
  );
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }): ReactNode {
  return <main className="error-screen"><span className="error-mark" aria-hidden="true">!</span><h1>vbmux could not load</h1><p>{message}</p><button className="button primary" onClick={onRetry}>Try again</button></main>;
}

function removeRow(layout: LayoutEntry[], index: number): LayoutEntry[] {
  return layout.filter((_, entryIndex) => entryIndex !== index);
}
