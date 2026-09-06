import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CSSProperties } from "react";
import type { HAConfig } from "../../src/homeAssistant";
import type { WaterHeaterConfig } from "../../src/plugins/waterHeater";
import {
  cancelLogin,
  checkLogin,
  getConfig,
  getElements,
  getStatus,
  requestPreview,
  saveConfig,
  setPause,
  startLogin,
  subscribeToEvents
} from "./api";
import { HomeAssistantSettings } from "./HomeAssistantSettings";
import type {
  AppConfig,
  BoardElement,
  BoardKind,
  ConfigValue,
  ConfigResponse,
  ElementsResponse,
  LayoutEntry,
  LoginStatus,
  PreviewMode,
  RuntimeStatus
} from "./types";
import {
  BOARD_DIMENSIONS,
  characterLabel,
  cloneConfig,
  elementById,
  formatDate,
  getBoardMatrix,
  getLayout,
  getPath,
  isLocked,
  relativeTime,
  setLayout,
  setPath,
  tileColor,
  validateLayout
} from "./utils";

type View = "board" | "connections";
type Notice = { tone: "success" | "error" | "info"; message: string } | undefined;

const BOARD_OPTIONS: Array<{ value: "auto" | BoardKind; label: string }> = [
  { value: "auto", label: "Auto detect" },
  { value: "note", label: "Note · 3 × 15" },
  { value: "flagship", label: "Flagship · 6 × 22" }
];

const DEFAULT_HA_CONFIG: HAConfig = { url: "", pause: null };
const DEFAULT_WATER_CONFIG: WaterHeaterConfig = {
  remaining: null,
  capacity: null,
  temperature: null,
  target: null,
  unit: "F",
  enabled: false
};

export default function App(): ReactNode {
  const [view, setView] = useState<View>("board");
  const [status, setStatus] = useState<RuntimeStatus>();
  const [configResponse, setConfigResponse] = useState<ConfigResponse>();
  const [elementsResponse, setElementsResponse] = useState<ElementsResponse>();
  const [draftConfig, setDraftConfig] = useState<AppConfig>();
  const [savedConfig, setSavedConfig] = useState<AppConfig>();
  const [draftLayout, setDraftLayout] = useState<LayoutEntry[]>([]);
  const [savedLayout, setSavedLayout] = useState<LayoutEntry[]>([]);
  const [selectedRow, setSelectedRow] = useState(0);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("desired");
  const [draftPreview, setDraftPreview] = useState<{ text: string; characters: number[][] }>();
  const [previewError, setPreviewError] = useState<string>();
  const [previewPending, setPreviewPending] = useState(false);
  const [events, setEvents] = useState<{ connected: boolean; error?: string }>({ connected: false, error: "Connecting to live updates…" });
  const [notice, setNotice] = useState<Notice>();
  const [loadError, setLoadError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const loadedOnce = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([getConfig(), getElements(), getStatus()])
      .then(([nextConfig, nextElements, nextStatus]) => {
        if (!active) return;
        const configuredLayout = getLayout(nextConfig.config);
        const nextLayout = configuredLayout === null || configuredLayout === undefined
          ? (nextElements.defaultLayout ?? [])
          : configuredLayout;
        setConfigResponse(nextConfig);
        setElementsResponse(nextElements);
        setStatus(nextStatus);
        setDraftConfig(cloneConfig(nextConfig.config));
        setSavedConfig(cloneConfig(nextConfig.config));
        setDraftLayout(nextLayout);
        setSavedLayout(nextLayout);
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
    (connected, error) => setEvents({ connected, error })
  ), []);

  const refreshElements = useCallback(async () => {
    try {
      setElementsResponse(await getElements());
    } catch (error: unknown) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "Could not refresh board elements." });
    }
  }, []);

  const boardPreference = readBoardPreference(draftConfig);
  const board = boardPreference === "auto" ? (status?.board ?? "note") : boardPreference;
  const elements = elementsResponse?.elements ?? [];
  const layoutError = validateLayout(draftLayout, elements, board);
  const isDirty = useMemo(() => {
    if (!draftConfig || !savedConfig) return draftLayout.length > 0;
    return JSON.stringify(draftConfig) !== JSON.stringify(savedConfig) || JSON.stringify(draftLayout) !== JSON.stringify(savedLayout);
  }, [draftConfig, draftLayout, savedConfig, savedLayout]);

  useEffect(() => {
    if (!loadedOnce.current || !elementsResponse || layoutError) {
      setDraftPreview(undefined);
      setPreviewError(layoutError);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      setPreviewPending(true);
      void requestPreview(draftLayout, boardPreference, getPath(draftConfig ?? {}, ["water"]))
        .then((nextPreview) => {
          if (!active) return;
          setDraftPreview(nextPreview);
          setPreviewError(undefined);
        })
        .catch((error: unknown) => {
          if (!active) return;
          setPreviewError(error instanceof Error ? error.message : "Could not preview this layout.");
        })
        .finally(() => {
          if (active) setPreviewPending(false);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [boardPreference, draftConfig, draftLayout, elementsResponse, layoutError]);

  const updateDraftConfig = useCallback((next: AppConfig) => {
    setDraftConfig(next);
    setNotice(undefined);
  }, []);

  const handleApply = useCallback(async () => {
    if (!draftConfig || layoutError) return;
    setNotice(undefined);
    try {
      const response = await saveConfig(setLayout(draftConfig, draftLayout));
      const nextElements = await getElements();
      setConfigResponse(response);
      setElementsResponse(nextElements);
      setDraftConfig(cloneConfig(response.config));
      setSavedConfig(cloneConfig(response.config));
      setSavedLayout(draftLayout);
      setNotice({ tone: "success", message: "Changes saved." });
    } catch (error: unknown) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "Could not save changes." });
    }
  }, [draftConfig, draftLayout, layoutError]);

  const handleDiscard = useCallback(() => {
    if (!savedConfig) return;
    setDraftConfig(cloneConfig(savedConfig));
    setDraftLayout(savedLayout);
    setSelectedRow(0);
    setNotice({ tone: "info", message: "Draft changes discarded." });
  }, [savedConfig, savedLayout]);

  const handlePause = useCallback(async () => {
    if (!status) return;
    try {
      await setPause(!status.manualPause);
      const nextStatus = await getStatus();
      setStatus(nextStatus);
      setNotice({ tone: "success", message: nextStatus.manualPause ? "Updates paused." : nextStatus.haPause ? "Manual pause cleared; Home Assistant still holds updates." : "Updates resumed." });
    } catch (error: unknown) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "Could not change pause state." });
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
        <a className="wordmark" href="#board" onClick={(event) => { event.preventDefault(); setView("board"); }}>vbmux</a>
        <nav className="top-nav" aria-label="Primary">
          <button className={view === "board" ? "nav-tab active" : "nav-tab"} onClick={() => setView("board")} aria-current={view === "board" ? "page" : undefined}>Board</button>
          <button className={view === "connections" ? "nav-tab active" : "nav-tab"} onClick={() => setView("connections")} aria-current={view === "connections" ? "page" : undefined}>Connections</button>
        </nav>
        <div className={events.connected ? "live-status is-live" : "live-status"} role="status">
          <span className="status-dot" aria-hidden="true" />
          <span>{events.connected ? "Live updates" : "Reconnecting"}</span>
        </div>
      </header>

      <main className="page-shell">
        {view === "board" ? (
          <BoardScreen
            board={board}
            boardPreference={boardPreference}
            status={status}
            elements={elements}
            draftLayout={draftLayout}
            selectedRow={selectedRow}
            setSelectedRow={setSelectedRow}
            setDraftLayout={(next) => { setDraftLayout(next); setNotice(undefined); }}
            previewMode={previewMode}
            setPreviewMode={setPreviewMode}
            preview={previewMode === "desired" && isDirty && draftPreview ? draftPreview : previewMode === "desired" ? status?.desired : status?.lastSent}
            previewPending={previewPending}
            previewError={previewError}
            draftConfig={draftConfig}
            updateDraftConfig={updateDraftConfig}
            configResponse={configResponse}
            onRefreshElements={refreshElements}
            onPause={handlePause}
            onApply={handleApply}
            onDiscard={handleDiscard}
            dirty={isDirty}
            layoutError={layoutError}
            notice={notice}
          />
        ) : (
          <ConnectionsScreen
            login={login}
            status={status}
            config={draftConfig}
            configResponse={configResponse}
            dirty={isDirty}
            layoutError={layoutError}
            notice={notice}
            onApply={handleApply}
            onDiscard={handleDiscard}
            onConfigChange={(ha, water) => {
              setDraftConfig((current) => current
                ? setPath(setPath(current, "ha", ha as unknown as ConfigValue), "water", water as unknown as ConfigValue)
                : current);
              setNotice(undefined);
            }}
            onLogin={(nextLogin) => setStatus((current) => current ? { ...current, login: nextLogin } : current)}
            onNotice={setNotice}
          />
        )}
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
  selectedRow: number;
  setSelectedRow: (index: number) => void;
  setDraftLayout: (layout: LayoutEntry[]) => void;
  previewMode: PreviewMode;
  setPreviewMode: (mode: PreviewMode) => void;
  preview: { text: string; characters: number[][] } | undefined;
  previewPending: boolean;
  previewError: string | undefined;
  draftConfig: AppConfig | undefined;
  updateDraftConfig: (config: AppConfig) => void;
  configResponse: ConfigResponse | undefined;
  onRefreshElements: () => Promise<void>;
  onPause: () => void;
  onApply: () => void;
  onDiscard: () => void;
  dirty: boolean;
  layoutError: string | undefined;
  notice: Notice;
}

function BoardScreen(props: BoardScreenProps): ReactNode {
  const {
    board, boardPreference, status, elements, draftLayout, selectedRow, setSelectedRow, setDraftLayout,
    previewMode, setPreviewMode, preview, previewPending, previewError, draftConfig, updateDraftConfig,
    configResponse, onRefreshElements, onPause, onApply, onDiscard, dirty, layoutError, notice
  } = props;
  const selectedEntryIndex = draftLayout.findIndex((entry) => {
    const element = elementById(elements, entry.elementId);
    return element && selectedRow >= entry.startRow && selectedRow < entry.startRow + element.height;
  });
  const selectedEntry = selectedEntryIndex >= 0 ? draftLayout[selectedEntryIndex] : undefined;
  const selectedElement = selectedEntry ? elementById(elements, selectedEntry.elementId) : undefined;
  const dimensions = BOARD_DIMENSIONS[board];
  const layoutLocked = isLocked(configResponse?.locked ?? [], ["layout", "elements_config.layout", "elementsConfig.layout"]);

  return (
    <>
      <div className="page-heading board-heading">
        <div>
          <h1>Your board</h1>
          <p>{status?.lastSentAt ? `Last sent ${relativeTime(status.lastSentAt).toLowerCase()}` : "Last sent: no reading yet"}</p>
        </div>
        <button className="button secondary pause-button" onClick={onPause} disabled={!status}>
          <span aria-hidden="true">{status?.manualPause ? "▶" : "Ⅱ"}</span>
          {status?.manualPause ? "Resume updates" : "Pause updates"}
        </button>
      </div>

      <div className="board-workspace">
        <section className="board-stage" aria-label="Board preview">
          <BoardPreview
            board={board}
            message={preview}
            selectedRow={selectedRow}
            layout={draftLayout}
            elements={elements}
            onSelectRow={setSelectedRow}
          />
          <div className="board-meta-row">
            <div className="segmented-control" role="group" aria-label="Board message version">
              <button className={previewMode === "desired" ? "selected" : ""} onClick={() => setPreviewMode("desired")}>Desired</button>
              <button className={previewMode === "lastSent" ? "selected" : ""} onClick={() => setPreviewMode("lastSent")}>Last sent</button>
            </div>
            <div className="board-facts">
              {previewPending ? <span>Updating preview…</span> : null}
              {status?.paused ? <span className="fact-warning">{pauseReason(status)}</span> : null}
            </div>
          </div>
          <div className="message-caption">
            <span>{previewMode === "desired" ? (dirty ? "Draft message" : "Desired message") : "Last sent message"}</span>
            <code>{preview?.text || "No reading yet"}</code>
          </div>
          <RuntimeMessages status={status} />
        </section>

        <aside className="editor-panel" aria-label="Board editor">
          <div className="editor-title-row">
            <h2>Rows</h2>
            <span className="board-size">{board === "note" ? "Note · 3 × 15" : "Flagship · 6 × 22"}</span>
          </div>
          <RowEditor
            board={board}
            elements={elements}
            layout={draftLayout}
            selectedRow={selectedRow}
            onSelectRow={setSelectedRow}
            onChange={setDraftLayout}
            locked={layoutLocked}
          />
          <div className="editor-preview-block">
            <div className="subheading-row">
              <h3>{`Row ${selectedRow + 1} preview`}</h3>
              {selectedElement ? <span className="height-label">{selectedElement.height} row{selectedElement.height === 1 ? "" : "s"}</span> : null}
            </div>
            <MiniPreview element={selectedElement} />
            <div className="picker-field">
              <label htmlFor="element-picker">Choose content</label>
              <select
                id="element-picker"
                value={selectedEntry?.elementId ?? ""}
                onChange={(event) => setDraftLayout(selectElement(draftLayout, selectedEntryIndex, selectedRow, event.target.value, elements))}
                onFocus={() => { void onRefreshElements(); }}
                disabled={layoutLocked}
              >
                <option value="">Choose content</option>
                {elements.map((element) => <option key={element.id} value={element.id}>{element.label}</option>)}
              </select>
            </div>
          </div>
          <div className="editor-actions">
            <button className="button secondary" onClick={onDiscard} disabled={!dirty}>Discard</button>
            <button className="button primary" onClick={onApply} disabled={!dirty || Boolean(layoutError)}>Apply</button>
          </div>
          {layoutError ? <p className="inline-message error" role="alert">{layoutError}</p> : null}
          {previewError && !layoutError ? <p className="inline-message error" role="alert">{previewError}</p> : null}
          {notice ? <p className={`inline-message ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p> : null}
        </aside>
      </div>

      <details className="settings-disclosure">
        <summary><span aria-hidden="true">⌄</span> Board settings</summary>
        <SettingsPanel
          config={draftConfig}
          response={configResponse}
          preference={boardPreference}
          onChange={updateDraftConfig}
        />
      </details>
      <p className="screen-footnote">Next attempt: {status?.paused ? "Updates paused" : status?.nextAttemptAt ? formatDate(status.nextAttemptAt) : "Ready"}</p>
    </>
  );
}

interface BoardPreviewProps {
  board: BoardKind;
  message: { text: string; characters: number[][] } | undefined;
  selectedRow: number;
  layout: LayoutEntry[];
  elements: BoardElement[];
  onSelectRow: (index: number) => void;
}

function BoardPreview({ board, message, selectedRow, layout, elements, onSelectRow }: BoardPreviewProps): ReactNode {
  const matrix = getBoardMatrix(message?.characters, board);
  const dimensions = BOARD_DIMENSIONS[board];
  return (
    <div className={`board-frame ${board}`}>
      <div className="vestaboard" style={{ "--board-columns": dimensions.columns } as CSSProperties}>
        {matrix.map((row, rowIndex) => {
          const matchingIndex = layout.findIndex((entry) => {
            const element = elementById(elements, entry.elementId);
            return element && rowIndex >= entry.startRow && rowIndex < entry.startRow + element.height;
          });
          const matchingEntry = matchingIndex >= 0 ? layout[matchingIndex] : undefined;
          const matchingElement = matchingEntry ? elementById(elements, matchingEntry.elementId) : undefined;
          const rowLabel = matchingElement ? `Select ${elementLabel(matchingElement)}` : `Select board row ${rowIndex + 1}`;
          return (
            <div
              className={rowIndex === selectedRow ? "board-row selected" : "board-row"}
              key={`board-row-${rowIndex}`}
              role="button"
              tabIndex={0}
              aria-label={rowLabel}
              onClick={() => onSelectRow(rowIndex)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectRow(rowIndex);
                }
              }}
            >
              {row.map((code, columnIndex) => (
                <span className={`board-cell ${tileColor(code)}${characterLabel(code) ? " has-glyph" : ""}`} key={`cell-${rowIndex}-${columnIndex}`} aria-hidden="true">
                  {characterLabel(code)}
                </span>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface RowEditorProps {
  board: BoardKind;
  elements: BoardElement[];
  layout: LayoutEntry[];
  selectedRow: number;
  onSelectRow: (index: number) => void;
  onChange: (layout: LayoutEntry[]) => void;
  locked: boolean;
}

function RowEditor({ board, elements, layout, selectedRow, onSelectRow, onChange, locked }: RowEditorProps): ReactNode {
  const maxRows = BOARD_DIMENSIONS[board].rows;
  return layout.length > 0 ? (
    <div className="row-list" role="list" aria-label="Board rows">
      {layout.map((entry, index) => {
        const element = elementById(elements, entry.elementId);
        const label = elementLabel(element) || `row ${index + 1}`;
        return (
          <div className={selectedRow >= entry.startRow && selectedRow < entry.startRow + (element?.height ?? 1) ? "row-item selected" : "row-item"} key={`${entry.elementId}-${index}`} role="listitem">
            <button className="row-main" onClick={() => onSelectRow(entry.startRow)} aria-label={`Edit ${label} at board row ${entry.startRow + 1}`}>
              <span className="row-grip" aria-hidden="true">⠿</span>
              <span className="row-number">{entry.startRow + 1}</span>
              <span className="row-label">{label}</span>
            </button>
            <label className="row-start">
              <span className="sr-only">Start row for {label}</span>
              <input
                type="number"
                min={1}
                max={maxRows}
                value={entry.startRow + 1}
                onChange={(event) => onChange(setStartRow(layout, index, Number(event.target.value) - 1))}
                disabled={locked}
              />
            </label>
            <div className="row-actions">
              <button className="icon-button" aria-label={`Move ${label} up`} onClick={() => { const next = moveRow(layout, index, -1, maxRows, elements); onChange(next); onSelectRow(next[index]?.startRow ?? entry.startRow); }} disabled={locked || !canMoveRow(layout, index, -1, maxRows, elements)}>↑</button>
              <button className="icon-button" aria-label={`Move ${label} down`} onClick={() => { const next = moveRow(layout, index, 1, maxRows, elements); onChange(next); onSelectRow(next[index]?.startRow ?? entry.startRow); }} disabled={locked || !canMoveRow(layout, index, 1, maxRows, elements)}>↓</button>
              <button className="icon-button danger" aria-label={`Remove ${label}`} onClick={() => { onChange(removeRow(layout, index)); onSelectRow(Math.min(entry.startRow, maxRows - 1)); }} disabled={locked}>×</button>
            </div>
          </div>
        );
      })}
    </div>
  ) : <div className="empty-rows">No rows are configured yet.</div>;
}

function MiniPreview({ element }: { element: BoardElement | undefined }): ReactNode {
  if (!element) return <div className="mini-preview empty">Choose an element to preview it.</div>;
  return (
    <div className="mini-preview" aria-label={`${elementLabel(element)} preview`}>
      {element.preview.flatMap((row, rowIndex) => row.map((code, columnIndex) => (
        <span className={`mini-cell ${tileColor(code)}${characterLabel(code) ? " has-glyph" : ""}`} key={`${rowIndex}-${columnIndex}`}>{characterLabel(code)}</span>
      )))}
    </div>
  );
}

function elementLabel(element: BoardElement | undefined): string {
  return element?.label ?? "Unavailable element";
}

function RuntimeMessages({ status }: { status: RuntimeStatus | undefined }): ReactNode {
  if (!status) return null;
  const messages = [
    status.deliveryError,
    status.configError,
    status.codex.error,
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

interface SettingsPanelProps {
  config: AppConfig | undefined;
  response: ConfigResponse | undefined;
  preference: "auto" | BoardKind;
  onChange: (config: AppConfig) => void;
}

function SettingsPanel({ config, response, preference, onChange }: SettingsPanelProps): ReactNode {
  if (!config) return null;
  const locked = response?.locked ?? [];
  const setValue = (paths: string[], value: string | number | boolean) => {
    const path = paths.find((candidate) => {
      const existing = getPath(config, [candidate]);
      return typeof existing === "string" || typeof existing === "number" || typeof existing === "boolean";
    }) ?? paths[0];
    onChange(setPath(config, path, value));
  };
  const textValue = (paths: string[]) => {
    const value = getPath(config, paths);
    return value === undefined || value === null ? "" : String(value);
  };
  const hasSecrets = response?.hasSecrets;
  const transportValue = hasSecrets?.localApiKey ? "local" : hasSecrets?.token ? "cloud" : "";
  const transportLocked = isLocked(locked, ["transport.token", "transport.localApiKey"]);
  const secretText = response?.hasSecrets.token ? "Cloud token configured" : response?.hasSecrets.localApiKey ? "Local API key configured" : "No board credential configured";
  return (
    <div className="settings-panel">
      <div className="settings-grid">
        <ConfigSelect label="Transport" value={transportValue} options={[{ value: "cloud", label: "Cloud" }, { value: "local", label: "Local" }]} locked={transportLocked} onChange={() => undefined} />
        <ConfigSelect label="Board" value={preference} options={BOARD_OPTIONS} locked={isLocked(locked, ["board", "boardPreference", "vestaboard.board"])} onChange={(value) => setValue(["boardPreference", "board", "vestaboard.board"], value)} />
        <ConfigNumber label="Poll interval (seconds)" value={textValue(["pollIntervalSeconds", "codexPollIntervalSeconds", "codex.pollIntervalSeconds"])} locked={isLocked(locked, ["pollIntervalSeconds", "codexPollIntervalSeconds", "codex.pollIntervalSeconds"])} onChange={(value) => setValue(["pollIntervalSeconds", "codexPollIntervalSeconds", "codex.pollIntervalSeconds"], value)} />
        <ConfigNumber label="Delivery interval (minutes)" value={textValue(["updateIntervalMinutes", "intervalMinutes", "deliveryIntervalMinutes", "delivery.intervalMinutes"])} locked={isLocked(locked, ["updateIntervalMinutes", "intervalMinutes", "deliveryIntervalMinutes", "delivery.intervalMinutes"])} onChange={(value) => setValue(["updateIntervalMinutes", "intervalMinutes", "deliveryIntervalMinutes", "delivery.intervalMinutes"], value)} />
        <ConfigToggle label="Show pacing" checked={Boolean(getPath(config, ["showPacing", "codex.showPacing"]))} locked={isLocked(locked, ["showPacing", "codex.showPacing"])} onChange={(checked) => setValue(["showPacing", "codex.showPacing"], checked)} />
        <ConfigToggle label="Auto-start 5h window" checked={Boolean(getPath(config, ["autoStartWindow5h", "codex.autoStartWindow5h"]))} locked={isLocked(locked, ["autoStartWindow5h", "codex.autoStartWindow5h"])} onChange={(checked) => setValue(["autoStartWindow5h", "codex.autoStartWindow5h"], checked)} />
        <ConfigToggle label="Auto-start weekly window" checked={Boolean(getPath(config, ["autoStartWindowWk", "codex.autoStartWindowWk"]))} locked={isLocked(locked, ["autoStartWindowWk", "codex.autoStartWindowWk"])} onChange={(checked) => setValue(["autoStartWindowWk", "codex.autoStartWindowWk"], checked)} />
      </div>
      <p className="settings-secret"><span className="secret-dot" aria-hidden="true" />{secretText}. Environment managed values are locked here.</p>
    </div>
  );
}

function ConfigSelect({ label, value, options, locked, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; locked: boolean; onChange: (value: string) => void }): ReactNode {
  return <label className="config-field"><span>{label}{locked ? <LockMark /> : null}</span><select value={value} disabled={locked} onChange={(event) => onChange(event.target.value)}><option value="">Not set</option>{options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>;
}

function ConfigNumber({ label, value, locked, onChange }: { label: string; value: string; locked: boolean; onChange: (value: number) => void }): ReactNode {
  return <label className="config-field"><span>{label}{locked ? <LockMark /> : null}</span><input type="number" min={0} value={value} disabled={locked} placeholder="Not set" onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function ConfigToggle({ label, checked, locked, onChange }: { label: string; checked: boolean; locked: boolean; onChange: (value: boolean) => void }): ReactNode {
  return <label className="config-toggle"><input type="checkbox" checked={checked} disabled={locked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span>{locked ? <LockMark /> : null}</label>;
}

function LockMark(): ReactNode { return <span className="lock-mark" title="Managed by environment" aria-label="Managed by environment">⌑</span>; }

function ConnectionsScreen({ login, status, config, configResponse, dirty, layoutError, notice, onApply, onDiscard, onConfigChange, onLogin, onNotice }: {
  login: LoginStatus;
  status: RuntimeStatus | undefined;
  config: AppConfig | undefined;
  configResponse: ConfigResponse | undefined;
  dirty: boolean;
  layoutError: string | undefined;
  notice: Notice;
  onApply: () => void;
  onDiscard: () => void;
  onConfigChange: (ha: HAConfig, water: WaterHeaterConfig) => void;
  onLogin: (status: LoginStatus) => void;
  onNotice: (notice: Notice) => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const act = async (operation: () => Promise<LoginStatus>, success?: string) => {
    setBusy(true);
    onNotice(undefined);
    try {
      const nextLogin = await operation();
      onLogin(nextLogin);
      if (success) onNotice({ tone: "success", message: success });
    } catch (error: unknown) {
      onNotice({ tone: "error", message: error instanceof Error ? error.message : "Could not update Codex login." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Connections</h1>
          <p>Connect Codex and Home Assistant to reuse quota, water, and pause signals in board rows.</p>
        </div>
      </div>
      <section className="connection-section" aria-labelledby="codex-heading">
        <div className="section-heading">
          <div><h2 id="codex-heading">Codex</h2><p>Sign in to read usage and quota updates.</p></div>
          <span className={login.account ? "connection-badge good" : login.pending ? "connection-badge pending" : "connection-badge"}>{login.account ? "Account connected" : login.pending ? "Sign-in pending" : login.error ? "Not connected" : "Account not checked"}</span>
        </div>
        <div className="login-panel">
          {login.pending && login.userCode ? <code className="device-code">{login.userCode}</code> : <span className="login-state">{login.account ? login.account : login.pending ? "Preparing device sign-in…" : login.error ? "Codex account not connected" : "Check status to verify the account"}</span>}
          <div className="login-actions">
            {login.pending && login.verificationUrl ? <a className="button secondary" href={login.verificationUrl} target="_blank" rel="noreferrer">Open device sign-in</a> : <button className="button secondary" onClick={() => void act(startLogin)} disabled={busy}>{busy ? "Starting…" : "Start device sign-in"}</button>}
            {login.pending ? <button className="button quiet" onClick={() => void act(cancelLogin, "Device sign-in cancelled.")} disabled={busy}>Cancel</button> : <button className="button quiet" onClick={() => void act(checkLogin)} disabled={busy}>Check status</button>}
          </div>
          <span className={login.pending ? "login-helper" : "login-helper muted"}>{login.pending ? "Waiting for approval" : login.error ?? ""}</span>
        </div>
        {login.error ? <p className="inline-message error" role="alert">{login.error}</p> : null}
      </section>
      <section className="connection-section" aria-labelledby="health-heading">
        <div className="section-heading">
          <div><h2 id="health-heading">Live status</h2><p>Connection health and pause signals update in real time.</p></div>
        </div>
        <div className="health-grid">
          <div className="health-card">
            <span className="health-label">Home Assistant</span>
            <span className={`connection-badge ${status?.homeAssistant?.connected ? "good" : status?.homeAssistant?.error ? "error" : ""}`}>
              {status?.homeAssistant?.connected ? "Connected" : status?.homeAssistant?.error ? "Connection error" : "Not connected"}
            </span>
            {status?.homeAssistant?.error ? <p className="inline-message error" role="alert">{status.homeAssistant.error}</p> : null}
          </div>
          <div className="health-card">
            <span className="health-label">Water heater</span>
            <span className={`connection-badge ${status?.water?.error ? "error" : ""}`}>{status?.water?.error ? "Needs attention" : "No errors"}</span>
            {status?.water?.error ? <p className="inline-message error" role="alert">{status.water.error}</p> : null}
          </div>
        </div>
      </section>
      <HomeAssistantSettings
        ha={readHAConfig(config)}
        water={readWaterConfig(config)}
        hasToken={Boolean(configResponse?.hasSecrets.haToken)}
        onChange={onConfigChange}
      />
      <div className="connection-actions">
        <button className="button secondary" type="button" onClick={onDiscard} disabled={!dirty}>Discard</button>
        <button className="button primary" type="button" onClick={onApply} disabled={!dirty || Boolean(layoutError)}>Apply</button>
      </div>
      {layoutError ? <p className="inline-message error" role="alert">{layoutError} Fix the board layout before applying these connection settings.</p> : null}
      {notice ? <p className={`inline-message ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p> : null}
      <section className="connection-note" aria-label="More connections">
        <span className="note-mark" aria-hidden="true">↗</span>
        <div><h2>Board credentials</h2><p>Transport and environment-managed board credentials are available from Board settings.</p></div>
      </section>
    </>
  );
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }): ReactNode {
  return <main className="error-screen"><span className="error-mark" aria-hidden="true">!</span><h1>vbmux could not load</h1><p>{message}</p><button className="button primary" onClick={onRetry}>Try again</button></main>;
}

function selectElement(layout: LayoutEntry[], index: number, startRow: number, elementId: string, elements: BoardElement[]): LayoutEntry[] {
  if (!elementId || !elementById(elements, elementId)) return layout;
  if (index >= 0) return layout.map((entry, entryIndex) => entryIndex === index ? { ...entry, elementId } : entry);
  const nextEntry = { elementId, startRow };
  const insertAt = layout.findIndex((entry) => entry.startRow > startRow);
  if (insertAt < 0) return [...layout, nextEntry];
  return [...layout.slice(0, insertAt), nextEntry, ...layout.slice(insertAt)];
}

function setStartRow(layout: LayoutEntry[], index: number, startRow: number): LayoutEntry[] {
  return layout.map((entry, entryIndex) => entryIndex === index ? { ...entry, startRow: Number.isFinite(startRow) ? startRow : 0 } : entry);
}

function moveRow(layout: LayoutEntry[], index: number, direction: -1 | 1, maxRows: number, elements: BoardElement[]): LayoutEntry[] {
  if (!canMoveRow(layout, index, direction, maxRows, elements)) return layout;
  const entry = layout[index];
  const height = elementById(elements, entry.elementId)?.height ?? 1;
  const targetStart = entry.startRow + direction;
  const collisionIndex = layout.findIndex((other, otherIndex) => otherIndex !== index && rangesOverlap(
    targetStart, targetStart + height, other.startRow, other.startRow + (elementById(elements, other.elementId)?.height ?? 1)
  ));
  const next = layout.map((item) => ({ ...item }));
  if (collisionIndex < 0) {
    next[index].startRow = targetStart;
    return next;
  }
  const other = layout[collisionIndex];
  const otherHeight = elementById(elements, other.elementId)?.height ?? 1;
  if (direction < 0) {
    next[index].startRow = other.startRow;
    next[collisionIndex].startRow = other.startRow + height;
  } else {
    next[index].startRow = entry.startRow + otherHeight;
    next[collisionIndex].startRow = entry.startRow;
  }
  return next;
}

function canMoveRow(layout: LayoutEntry[], index: number, direction: -1 | 1, maxRows: number, elements: BoardElement[]): boolean {
  const entry = layout[index];
  if (!entry) return false;
  const height = elementById(elements, entry.elementId)?.height ?? 1;
  const targetStart = entry.startRow + direction;
  if (targetStart < 0 || targetStart + height > maxRows) return false;
  const collisionIndex = layout.findIndex((other, otherIndex) => otherIndex !== index && rangesOverlap(
    targetStart, targetStart + height, other.startRow, other.startRow + (elementById(elements, other.elementId)?.height ?? 1)
  ));
  if (collisionIndex < 0) return true;
  const other = layout[collisionIndex];
  const otherHeight = elementById(elements, other.elementId)?.height ?? 1;
  const swappedEntryStart = direction < 0 ? other.startRow : entry.startRow + otherHeight;
  const swappedOtherStart = direction < 0 ? other.startRow + height : entry.startRow;
  return swappedEntryStart >= 0 && swappedEntryStart + height <= maxRows
    && swappedOtherStart >= 0 && swappedOtherStart + otherHeight <= maxRows;
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number): boolean {
  return startA < endB && startB < endA;
}

function removeRow(layout: LayoutEntry[], index: number): LayoutEntry[] {
  return layout.filter((_, entryIndex) => entryIndex !== index);
}

function pauseReason(status: RuntimeStatus): string {
  if (status.manualPause && status.haPause) return "Paused manually + by Home Assistant";
  if (status.haPause) return "Paused by Home Assistant";
  if (status.manualPause) return "Paused manually";
  return "Paused";
}

function readHAConfig(config: AppConfig | undefined): HAConfig {
  const value = getPath(config ?? {}, ["ha", "homeAssistant"]);
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_HA_CONFIG };
  const candidate = value as Partial<HAConfig>;
  const pause = candidate.pause && typeof candidate.pause === "object"
    ? {
        entityId: typeof candidate.pause.entityId === "string" ? candidate.pause.entityId : "",
        pauseValue: typeof candidate.pause.pauseValue === "string" ? candidate.pause.pauseValue : "on",
        resumeValue: typeof candidate.pause.resumeValue === "string" ? candidate.pause.resumeValue : "off"
      }
    : null;
  return {
    url: typeof candidate.url === "string" ? candidate.url : "",
    ...(typeof candidate.token === "string" ? { token: candidate.token } : {}),
    pause
  };
}

function readWaterConfig(config: AppConfig | undefined): WaterHeaterConfig {
  const value = getPath(config ?? {}, ["water", "waterHeater"]);
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_WATER_CONFIG };
  const candidate = value as Partial<WaterHeaterConfig>;
  return {
    remaining: candidate.remaining ?? null,
    capacity: candidate.capacity ?? null,
    temperature: candidate.temperature ?? null,
    target: candidate.target ?? null,
    unit: candidate.unit === "C" ? "C" : "F",
    ...(typeof candidate.baseline === "number" ? { baseline: candidate.baseline } : {}),
    enabled: candidate.enabled === true
  };
}

function readBoardPreference(config: AppConfig | undefined): "auto" | BoardKind {
  for (const path of ["boardPreference", "board", "vestaboard.board"]) {
    const value = getPath(config ?? {}, [path]);
    if (value === "note" || value === "flagship" || value === "auto") return value;
  }
  return "auto";
}
