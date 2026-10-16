import type { ReactNode } from "react";
import type { PublicConfig } from "../../src/contracts/config.js";

export function UnsupportedConfigurationWarning({ configuration, saving, disabled, onRemove }: {
  configuration: PublicConfig["ignoredConfiguration"]; saving: boolean; disabled: boolean; onRemove: () => void;
}): ReactNode {
  if (!configuration.keys.length && !configuration.elementIds.length) return null;
  return <details className="legacy-warning" role="status">
    <summary><strong>Unsupported saved configuration detected</strong></summary>
    <p>These saved top-level keys and layout references are unsupported and ignored. Configure replacement content using the supported plugins: Codex, HA character blocks, and bar and text rows.</p>
    {configuration.keys.length ? <p>Saved keys: {configuration.keys.map((key, index) => <span key={key}>{index ? ", " : ""}<code>{key}</code></span>)}.</p> : null}
    {configuration.elementIds.length ? <p>Layout references: {configuration.elementIds.map((id, index) => <span key={id}>{index ? ", " : ""}<code>{id}</code></span>)}.</p> : null}
    <p>Remove the ignored saved data and layout references. Other saved settings and unsaved drafts are preserved.</p>
    <button type="button" className="button secondary" disabled={disabled} onClick={onRemove}>{saving ? "Removing…" : "Remove ignored saved data"}</button>
  </details>;
}
