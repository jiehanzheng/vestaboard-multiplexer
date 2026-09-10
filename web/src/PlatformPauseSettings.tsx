import { SettingsGroup } from "./SettingsGroup";
import type { ReactNode } from "react";
import type { HAConfig } from "../../src/contracts/config";
import type { HAEntity } from "../../src/contracts/homeAssistant";
import { EntityPicker } from "./EntityPicker";

export function PlatformPauseSettings({ value, entities, loading, error, onChange }: {
  value: HAConfig;
  entities: readonly HAEntity[];
  loading: boolean;
  error?: string;
  onChange: (value: HAConfig) => void;
}): ReactNode {
  const pause = value.pause;
  return (
    <SettingsGroup title="Pause from Home Assistant" description="Choose an optional entity and the values that pause and resume the board.">
        <EntityPicker
          id="ha-pause-entity"
          label="Pause entity"
          value={pause?.entityId ?? ""}
          entities={entities}
          loading={loading}
          error={error}
          onChange={(entityId) => onChange({ ...value, pause: entityId ? { entityId, pauseValue: pause?.pauseValue ?? "on", resumeValue: pause?.resumeValue ?? "off" } : null })}
        />
      <div className="settings-grid">
        <label className="config-field">
          <span>Pause value</span>
          <input id="ha-pause-value" value={pause?.pauseValue ?? ""} placeholder="on" disabled={!pause} onChange={(event) => pause && onChange({ ...value, pause: { ...pause, pauseValue: event.target.value } })} />
        </label>
        <label className="config-field">
          <span>Resume value</span>
          <input id="ha-resume-value" value={pause?.resumeValue ?? ""} placeholder="off" disabled={!pause} onChange={(event) => pause && onChange({ ...value, pause: { ...pause, resumeValue: event.target.value } })} />
        </label>
      </div>
    </SettingsGroup>
  );
}
