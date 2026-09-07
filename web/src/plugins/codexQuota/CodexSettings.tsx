import type { ReactNode } from "react";
import { CodexConfigSchema, type CodexConfig } from "../../../../src/contracts/config";
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
      <WindowLabelField label="Window 1 label" value={value.window1Label} field="window1Label" config={value} onChange={(window1Label) => update({ window1Label })} />
      <WindowLabelField label="Window 2 label" value={value.window2Label} field="window2Label" config={value} onChange={(window2Label) => update({ window2Label })} />
    </>
  );
}

function WindowLabelField({ label, value, field, config, onChange }: {
  label: string;
  value: CodexConfig["window1Label"];
  field: "window1Label" | "window2Label";
  config: CodexConfig;
  onChange: (value: CodexConfig["window1Label"]) => void;
}): ReactNode {
  const mode = value === null ? "automatic" : "custom";
  const issue = labelValidationMessage(config, field);
  const modeId = `${field}-mode`;
  const valueId = `${field}-value`;
  return (
    <fieldset className="config-field">
      <legend>{label}</legend>
      <label htmlFor={modeId}><span>Mode</span></label>
      <select id={modeId} value={mode} onChange={(event) => {
        if (event.target.value === "automatic") onChange(null);
        else onChange(value ?? "");
      }}>
        <option value="automatic">Automatic</option>
        <option value="custom">Custom</option>
      </select>
      {mode === "custom" ? <>
        <label htmlFor={valueId}><span>Custom value</span></label>
        <input
          id={valueId}
          aria-invalid={issue ? "true" : undefined}
          maxLength={2}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value.toUpperCase())}
          placeholder="1–2 characters"
        />
      </> : null}
      <small className={issue ? "error-text" : "screen-footnote"}>{issue ?? "Automatic uses the calculated duration label."}</small>
    </fieldset>
  );
}

function labelValidationMessage(config: CodexConfig, field: "window1Label" | "window2Label"): string | undefined {
  if (config[field] === null) return undefined;
  const result = CodexConfigSchema.safeParse(config);
  if (result.success) return undefined;
  return result.error.issues.find((issue) => issue.path[0] === field)?.message;
}
