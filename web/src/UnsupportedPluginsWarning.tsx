import type { ReactNode } from "react";
import type { PublicConfig } from "../../src/contracts/config.js";

export function UnsupportedPluginsWarning({ plugins, saving, disabled, onRemove }: {
  plugins: PublicConfig["ignoredPlugins"]; saving: boolean; disabled: boolean; onRemove: () => void;
}): ReactNode {
  if (!plugins.length) return null;
  return <details className="legacy-warning" role="status">
    <summary><strong>Retired plugin settings detected</strong></summary>
    <p>The dedicated Water heater plugin has been retired. These saved settings and layout references are ignored. Replace remaining-water displays with generic HA bar and text rows; supply temperature and EMV displays through HA character blocks. Home Assistant owns the calculations.</p>
    <ul>{plugins.map((plugin) => <li key={plugin.id}>
      {plugin.settingsPresent ? <span>Saved key: <code>{plugin.id}</code>. </span> : null}
      {plugin.elementIds.length ? <span>Layout references: {plugin.elementIds.map((id, index) => <span key={id}>{index ? ", " : ""}<code>{id}</code></span>)}.</span> : null}
    </li>)}</ul>
    <p>Remove the ignored payload and layout references from saved configuration. Other saved settings and unsaved drafts are preserved.</p>
    <button type="button" className="button secondary" disabled={disabled} onClick={onRemove}>{saving ? "Removing…" : "Remove retired settings and placements"}</button>
  </details>;
}
