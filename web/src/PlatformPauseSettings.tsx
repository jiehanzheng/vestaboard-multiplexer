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
    <section className="settings-panel" aria-labelledby="pause-heading">
      <div className="subheading-row"><h3 id="pause-heading">Pause from Home Assistant</h3></div>
      <p className="screen-footnote">Updates pause when the selected entity matches the pause value.</p>
      <div className="settings-grid">
        <EntityPicker
          id="ha-pause-entity"
          label="Pause entity"
          value={pause?.entityId ?? ""}
          entities={entities}
          loading={loading}
          error={error}
          onChange={(entityId) => onChange({ ...value, pause: entityId ? { entityId, pauseValue: pause?.pauseValue ?? "on", resumeValue: pause?.resumeValue ?? "off" } : null })}
        />
        <label className="config-field">
          <span>Pause value</span>
          <input id="ha-pause-value" value={pause?.pauseValue ?? ""} placeholder="on" disabled={!pause} onChange={(event) => pause && onChange({ ...value, pause: { ...pause, pauseValue: event.target.value } })} />
        </label>
        <label className="config-field">
          <span>Resume value</span>
          <input id="ha-resume-value" value={pause?.resumeValue ?? ""} placeholder="off" disabled={!pause} onChange={(event) => pause && onChange({ ...value, pause: { ...pause, resumeValue: event.target.value } })} />
        </label>
      </div>
    </section>
  );
}
