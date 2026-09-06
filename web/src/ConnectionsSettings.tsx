import type { ReactNode } from "react";
import type { HAConfig, WaterHeaterConfig } from "../../src/contracts/config";
import type { HAEntity } from "../../src/contracts/homeAssistant";
import { HAConnectionSettings } from "./HAConnectionSettings";
import { PlatformPauseSettings } from "./PlatformPauseSettings";
import { WaterHeaterSettings } from "./plugins/waterHeater/WaterHeaterSettings";

export interface ConnectionsSettingsProps {
  ha: HAConfig;
  water: WaterHeaterConfig;
  hasToken: boolean;
  entities: readonly HAEntity[];
  entitiesLoading: boolean;
  entitiesError?: string;
  onChange: (ha: HAConfig, water: WaterHeaterConfig) => void;
  onRefreshEntities: () => void;
}

export function ConnectionsSettings({ ha, water, hasToken, entities, entitiesLoading, entitiesError, onChange, onRefreshEntities }: ConnectionsSettingsProps): ReactNode {
  return (
    <>
      <HAConnectionSettings value={ha} hasToken={hasToken} onChange={(next) => onChange(next, water)} />
      <div className="settings-panel entity-catalog-actions">
        <div><strong>Entity catalog</strong><p className="screen-footnote">Use the saved catalog for water readings and pause rules.</p></div>
        <button className="button secondary" type="button" onClick={onRefreshEntities} disabled={entitiesLoading || !ha.url.trim()}>{entitiesLoading ? "Loading…" : "Refresh entities"}</button>
        {entitiesError ? <p className="inline-message error" role="alert">{entitiesError}</p> : null}
      </div>
      <WaterHeaterSettings value={water} entities={entities} loading={entitiesLoading} error={entitiesError} onChange={(next) => onChange(ha, next)} />
      <PlatformPauseSettings value={ha} entities={entities} loading={entitiesLoading} error={entitiesError} onChange={(next) => onChange(next, water)} />
    </>
  );
}
