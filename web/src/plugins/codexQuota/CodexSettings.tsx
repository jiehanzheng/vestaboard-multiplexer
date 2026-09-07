import type { ReactNode } from "react";
import type { CodexConfig } from "../../../../src/contracts/config";
import { ConfigNumber, ConfigSelect, ConfigToggle } from "../../ConfigControls";

export function CodexSettings({ value, onChange }: { value: CodexConfig; onChange: (value: CodexConfig) => void }): ReactNode {
  const update = (patch: Partial<CodexConfig>) => onChange({ ...value, ...patch });
  return (
    <>
      <ConfigToggle label="Enable Codex quota" checked={value.enabled} onChange={(enabled) => update({ enabled })} />
      <ConfigSelect label="Quota source" value={value.source} options={[{ value: "app-server", label: "Codex app-server" }, { value: "fixture", label: "Fixture data" }]} onChange={(source) => update({ source: source as CodexConfig["source"] })} />
      <ConfigNumber label="Poll interval (seconds)" value={String(value.pollIntervalSeconds)} onChange={(pollIntervalSeconds) => update({ pollIntervalSeconds })} />
      <label className="config-field">
        <span>Time zone</span>
        <input value={value.timeZone ?? ""} placeholder="Local process time" onChange={(event) => update({ timeZone: event.target.value || undefined })} />
      </label>
      <ConfigToggle label="Show pacing" checked={value.showPacing} onChange={(showPacing) => update({ showPacing })} />
      <ConfigToggle label="Auto-start 5h window" checked={value.autoStartWindow5h} onChange={(autoStartWindow5h) => update({ autoStartWindow5h })} />
      <ConfigToggle label="Auto-start weekly window" checked={value.autoStartWindowWk} onChange={(autoStartWindowWk) => update({ autoStartWindowWk })} />
    </>
  );
}
