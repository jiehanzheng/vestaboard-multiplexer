import type { ReactNode } from "react";
import type { HAEntity } from "../../src/contracts/homeAssistant";
import type { AppConfig } from "../../src/contracts/config";
import { ConfigNumber, ConfigSelect } from "./ConfigControls";
import { HAConnectionSettings } from "./HAConnectionSettings";
import { PlatformPauseSettings } from "./PlatformPauseSettings";
import { PauseOverlayEditor } from "./PauseOverlayEditor";
import { PluginRow } from "./PluginRow";
import { SectionSaveActions } from "./SectionSaveActions";
import { CodexLoginSettings } from "./plugins/codexQuota/CodexLoginSettings";
import { CodexSettings } from "./plugins/codexQuota/CodexSettings";
import { WaterHeaterSettings } from "./plugins/waterHeater/WaterHeaterSettings";
import type { WaterHeaterStatus } from "../../src/plugins/waterHeater/status.js";
import type { ConfigSection } from "./draftState";
import type { ConfigResponse, LoginStatus, RuntimeStatus } from "./types";
import type { Notice } from "./notice";

export type PluginView = "codex" | "water";

interface SharedProps {
  status: RuntimeStatus | undefined;
  config: AppConfig;
  configResponse: ConfigResponse | undefined;
  dirty: (section: ConfigSection) => boolean;
  saving: ConfigSection | undefined;
  notice: Notice;
  onSave: (section: ConfigSection) => void;
  onDiscard: (section: ConfigSection) => void;
  entities: readonly HAEntity[];
  entitiesLoading: boolean;
  entitiesError?: string;
  onRefreshEntities: () => void;
  onConfigChange: (config: AppConfig) => void;
  onLogin: (status: LoginStatus) => void;
  onNotice: (notice: Notice) => void;
  onOpenSettings: () => void;
  onOpenLogs: (source?: string) => void;
}

export function PluginsScreen({ login, plugin, onPluginChange, ...props }: SharedProps & { login: LoginStatus; plugin: PluginView | undefined; onPluginChange: (plugin: PluginView | undefined) => void }): ReactNode {
  if (!plugin) return <>
    <div className="page-heading"><div><h1>Plugins</h1><p>Choose a plugin to manage its behavior and display settings.</p></div></div>
    <section className="plugin-list" aria-label="Plugins">
      <PluginRow title="Codex" purpose="Quota account, pacing, polling, and auto-start behavior." status={props.status?.codex.error || login.error ? "Needs attention" : login.account ? `Connected · ${login.account}` : login.pending ? "Sign-in pending" : "Account not checked"} dirty={props.dirty("codex")} onOpen={() => onPluginChange("codex")} />
      <PluginRow title="Water heater" purpose="Readings, units, entity selection, and display settings." status={props.status?.water?.error ? "Needs attention" : props.config.water.enabled ? "Enabled" : "Disabled"} dirty={props.dirty("water")} onOpen={() => onPluginChange("water")} />
    </section>
  </>;
  const saving = props.saving === plugin;
  const savingAny = Boolean(props.saving);
  const paneNotice = props.notice?.section === plugin ? props.notice : undefined;
  if (plugin === "codex") return <PluginDetail title="Codex" onBack={() => onPluginChange(undefined)} dirty={props.dirty("codex")} saving={saving} saveDisabled={savingAny && !saving} onSave={() => props.onSave("codex")} onDiscard={() => props.onDiscard("codex")} notice={paneNotice}>
    <CodexLoginSettings login={login} quotaError={props.status?.codex.error} onLogin={props.onLogin} onNotice={(next) => props.onNotice(next ? { ...next, section: "codex" } : undefined)} />
    <button className="text-link" type="button" onClick={() => props.onOpenLogs("codex")}>View Codex logs</button>
    <section className="connection-section" aria-labelledby="codex-quota-heading"><div className="section-heading"><div><h2 id="codex-quota-heading">Quota settings</h2><p>Choose how Codex collects and displays usage for board rows.</p></div></div><div className="settings-panel"><div className="settings-grid"><CodexSettings value={props.config.codex} onChange={(codex) => props.onConfigChange({ ...props.config, codex })} /></div></div></section>
  </PluginDetail>;
  const savedHaUrl = props.configResponse?.config.ha.url.trim() ?? "";
  return <PluginDetail title="Water heater" onBack={() => onPluginChange(undefined)} dirty={props.dirty("water")} saving={saving} saveDisabled={savingAny && !saving} onSave={() => props.onSave("water")} onDiscard={() => props.onDiscard("water")} notice={paneNotice}>
    <section className="connection-section" aria-labelledby="water-readings-heading"><div className="section-heading"><div><h2 id="water-readings-heading">Readings</h2><p>Choose the readings and units that the Water Heater plugin renders.</p></div></div><WaterHeaterSettings board={props.status?.board ?? "note"} value={props.config.water} status={props.status?.water as WaterHeaterStatus | undefined} saved={!props.dirty("water")} entities={props.entities} loading={props.entitiesLoading} error={props.entitiesError} onChange={(water) => props.onConfigChange({ ...props.config, water })} /><WaterCatalogMessage savedHaUrl={savedHaUrl} haDirty={props.dirty("ha")} entities={props.entities} loading={props.entitiesLoading} error={props.entitiesError} onRefresh={props.onRefreshEntities} onOpenSettings={props.onOpenSettings} /></section>
    <button className="text-link" type="button" onClick={() => props.onOpenLogs("water")}>View Water Heater logs</button>
  </PluginDetail>;
}

export function SettingsScreen(props: SharedProps): ReactNode {
  const savingAny = Boolean(props.saving);
  return (
    <>
      <div className="page-heading"><div><h1>Settings</h1><p>Manage board output and shared services. Each section saves independently.</p><button className="text-link" type="button" onClick={() => props.onOpenLogs()}>View live logs</button></div></div>
      <section className="settings-section" aria-labelledby="board-output-heading">
        <div className="section-heading"><div><h2 id="board-output-heading">Board output</h2><p>Choose the board and delivery credentials used by vbmux.</p></div></div>
        <BoardOutputSettings config={props.config} response={props.configResponse} onChange={props.onConfigChange} dirty={props.dirty("board")} saving={props.saving === "board"} saveDisabled={savingAny && props.saving !== "board"} feedback={sectionNotice(props.notice, "board")} onSave={() => props.onSave("board")} onDiscard={() => props.onDiscard("board")} />
      </section>
      <section className="settings-section" aria-labelledby="home-assistant-heading">
        <HAConnectionSettings value={props.config.ha} hasToken={Boolean(props.configResponse?.hasSecrets.haToken)} saved={!props.dirty("ha")} status={props.status?.homeAssistant?.connected ? "Connected" : props.status?.homeAssistant?.error ? "Connection error" : "Not connected"} onChange={(ha) => props.onConfigChange({ ...props.config, ha: { ...ha, pause: props.config.ha.pause } })} />
        <SectionSaveActions label="Home Assistant" dirty={props.dirty("ha")} saving={props.saving === "ha"} saveDisabled={savingAny && props.saving !== "ha"} feedback={sectionNotice(props.notice, "ha")} onSave={() => props.onSave("ha")} onDiscard={() => props.onDiscard("ha")} />
        <EntityCatalog savedHaUrl={props.configResponse?.config.ha.url.trim() ?? ""} dirty={props.dirty("ha")} entities={props.entities} loading={props.entitiesLoading} error={props.entitiesError} onRefresh={props.onRefreshEntities} />
      </section>
      <section className="settings-section" aria-labelledby="pause-settings-heading">
        <div className="section-heading"><div><h2 id="pause-settings-heading">Pause settings</h2><p>Pause content manually or from an optional Home Assistant entity, then draw what appears over the frozen board.</p></div></div>
        <PlatformPauseSettings value={props.config.ha} entities={props.entities} loading={props.entitiesLoading} error={props.entitiesError} onChange={(ha) => props.onConfigChange({ ...props.config, ha: { ...props.config.ha, pause: ha.pause } })} />
        <PauseOverlayEditor board={props.status?.board ?? (props.config.board === "flagship" ? "flagship" : "note")} value={props.config.pauseOverlay} background={props.status?.pauseBackground ?? props.status?.desired ?? props.status?.lastSent} onChange={(pauseOverlay) => props.onConfigChange({ ...props.config, pauseOverlay })} />
        <SectionSaveActions label="pause settings" dirty={props.dirty("pause")} saving={props.saving === "pause"} saveDisabled={savingAny && props.saving !== "pause"} feedback={sectionNotice(props.notice, "pause")} onSave={() => props.onSave("pause")} onDiscard={() => props.onDiscard("pause")} />
      </section>
    </>
  );
}

function sectionNotice(notice: Notice, section: ConfigSection): Exclude<Notice, undefined> | undefined {
  return notice?.section === section ? notice : undefined;
}

function PluginDetail({ title, onBack, dirty, saving, saveDisabled, onSave, onDiscard, notice, children }: { title: string; onBack: () => void; dirty: boolean; saving: boolean; saveDisabled?: boolean; onSave: () => void; onDiscard: () => void; notice?: Exclude<Notice, undefined>; children: ReactNode }): ReactNode {
  return <section className="connection-pane" aria-labelledby="plugin-detail-heading"><button className="back-link" type="button" onClick={onBack}>← Back to Plugins</button><div className="page-heading connection-pane-heading"><div><h1 id="plugin-detail-heading">{title}</h1></div></div><div className="connection-pane-savebar"><SectionSaveActions label={title} dirty={dirty} saving={saving} saveDisabled={saveDisabled} feedback={notice} onSave={onSave} onDiscard={onDiscard} /></div>{children}</section>;
}

function BoardOutputSettings({ config, response, onChange, dirty, saving, saveDisabled, feedback, onSave, onDiscard }: { config: AppConfig; response: ConfigResponse | undefined; onChange: (config: AppConfig) => void; dirty: boolean; saving: boolean; saveDisabled?: boolean; feedback?: Exclude<Notice, undefined>; onSave: () => void; onDiscard: () => void }): ReactNode {
  const hasSecrets = response?.hasSecrets;
  const transportValue = hasSecrets?.localApiKey ? "local" : hasSecrets?.token ? "cloud" : "";
  return (
    <div className="settings-panel">
      <div className="settings-grid">
        <div className="config-field"><span>Active transport</span><output>{transportValue === "local" ? "Local API" : transportValue === "cloud" ? "Cloud API" : "Not configured"}</output></div>
        <ConfigSelect label="Board" value={config.board} options={[{ value: "auto", label: "Auto detect" }, { value: "note", label: "Note · 3 × 15" }, { value: "flagship", label: "Flagship · 6 × 22" }]} onChange={(board) => onChange({ ...config, board: board as AppConfig["board"] })} />
        <ConfigNumber label="Delivery interval (minutes)" value={String(config.updateIntervalMinutes)} onChange={(updateIntervalMinutes) => onChange({ ...config, updateIntervalMinutes })} />
        <label className="config-field"><span>Cloud API URL</span><input type="url" value={config.transport.cloudUrl} onChange={(event) => onChange({ ...config, transport: { ...config.transport, cloudUrl: event.target.value } })} /></label>
        <label className="config-field"><span>Cloud token</span><input type="password" autoComplete="new-password" value={config.transport.token ?? ""} placeholder={hasSecrets?.token ? "Saved token · type to replace" : "Paste token"} onChange={(event) => onChange({ ...config, transport: { ...config.transport, token: event.target.value } })} /><button className="button quiet" type="button" onClick={() => onChange({ ...config, transport: { ...config.transport, token: "" } })} disabled={!hasSecrets?.token && !config.transport.token}>Clear saved token</button></label>
        <label className="config-field"><span>Local API URL</span><input type="url" value={config.transport.localUrl} onChange={(event) => onChange({ ...config, transport: { ...config.transport, localUrl: event.target.value } })} /></label>
        <label className="config-field"><span>Local API key</span><input type="password" autoComplete="new-password" value={config.transport.localApiKey ?? ""} placeholder={hasSecrets?.localApiKey ? "Saved key · type to replace" : "Paste key"} onChange={(event) => onChange({ ...config, transport: { ...config.transport, localApiKey: event.target.value } })} /><button className="button quiet" type="button" onClick={() => onChange({ ...config, transport: { ...config.transport, localApiKey: "" } })} disabled={!hasSecrets?.localApiKey && !config.transport.localApiKey}>Clear saved key</button></label>
      </div>
      <SectionSaveActions label="board settings" dirty={dirty} saving={saving} saveDisabled={saveDisabled} feedback={feedback} onSave={onSave} onDiscard={onDiscard} />
    </div>
  );
}

function EntityCatalog({ savedHaUrl, dirty, entities, loading, error, onRefresh }: { savedHaUrl: string; dirty: boolean; entities: readonly HAEntity[]; loading: boolean; error?: string; onRefresh: () => void }): ReactNode {
  const message = dirty
    ? "Save Home Assistant above before refreshing this shared catalog."
    : loading
      ? "Loading entities from the saved connection…"
      : error
        ? "The saved connection could not load entities. Check the URL and token, then retry."
        : !savedHaUrl
          ? "Add and save a Home Assistant URL above to load entities."
          : entities.length === 0
            ? "No entities were returned. Check the saved connection and refresh."
            : `${entities.length} saved entities available to Water Heater and Pause automation.`;
  return <section className="settings-panel entity-catalog-actions" aria-label="Entity catalog"><div><strong>Saved entity catalog</strong><p className="screen-footnote">{message}</p></div><button className="button secondary" type="button" onClick={onRefresh} disabled={dirty || !savedHaUrl || loading}>{loading ? "Loading…" : error ? "Retry entities" : "Refresh entities"}</button>{error ? <p className="inline-message error" role="alert">{error}</p> : null}</section>;
}

function WaterCatalogMessage({ savedHaUrl, haDirty, entities, loading, error, onRefresh, onOpenSettings }: { savedHaUrl: string; haDirty: boolean; entities: readonly HAEntity[]; loading: boolean; error?: string; onRefresh: () => void; onOpenSettings: () => void }): ReactNode {
  if (haDirty) return <p className="screen-footnote">Save Home Assistant in <button className="text-link" type="button" onClick={onOpenSettings}>Settings</button> before selecting entity readings. Constants remain available while the connection draft is unsaved.</p>;
  if (loading) return <p className="screen-footnote" role="status">Loading entities from the saved Home Assistant connection…</p>;
  if (error) return <p className="inline-message error" role="alert">Could not load saved entities: {error} <button className="text-link" type="button" onClick={onRefresh}>Retry</button></p>;
  if (!savedHaUrl) return <p className="screen-footnote">Home Assistant is not configured. Add a saved connection in <button className="text-link" type="button" onClick={onOpenSettings}>Settings</button> to select entity readings; constants remain available.</p>;
  if (entities.length === 0) return <p className="screen-footnote">No entities were returned from the saved connection. Check Home Assistant and <button className="text-link" type="button" onClick={onRefresh}>refresh</button>.</p>;
  return null;
}
