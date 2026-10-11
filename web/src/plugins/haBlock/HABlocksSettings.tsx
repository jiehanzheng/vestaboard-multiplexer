import { useState, type ReactNode } from "react";
import type { AppConfig } from "../../../../src/contracts/config.js";
import type { HAEntity } from "../../../../src/contracts/homeAssistant.js";
import type { HABlockStatus } from "../../../../src/plugins/haBlock/status.js";
import { addHABlockDraft, removeHABlockDraft, updateHABlockDraft } from "../../draftState";
import { PluginRow } from "../../PluginRow";
import { HABlockSettings } from "./HABlockSettings";

export function HABlocksSettings({ config, status, entities, loading, error, layoutError, onChange }: {
  config: AppConfig; status?: Record<string, HABlockStatus>; entities: readonly HAEntity[];
  loading: boolean; error?: string; layoutError?: string; onChange: (config: AppConfig) => void;
}): ReactNode {
  const [selectedId, setSelectedId] = useState<string>();
  const selected = config.haBlocks.find((block) => block.id === selectedId) ?? config.haBlocks[0];
  const value = selected ? (() => { const { id: _id, name: _name, ...settings } = selected; return settings; })() : undefined;
  return <div className="settings-stack">
    <div className="section-heading"><div><h2>Blocks</h2><p>Each block has its own source, size, unavailable display, and placement on Board.</p></div>
      <button className="button secondary" type="button" onClick={() => {
        const id = crypto.randomUUID();
        onChange(addHABlockDraft(config, id));
        setSelectedId(id);
      }}>Add block</button>
    </div>
    {config.haBlocks.length ? <section className="plugin-list" aria-label="HA character blocks">
      {config.haBlocks.map((block) => <PluginRow key={block.id} title={block.name || "Unnamed block"} purpose={block.entityId || "Choose a source entity"}
        status={selected?.id === block.id ? "Editing" : status?.[block.id]?.error ? "Needs attention" : block.enabled ? "Enabled" : "Disabled"}
        onOpen={() => setSelectedId(block.id)} />)}
    </section> : <p className="screen-footnote">Add your first block, choose its source, then place it on Board. Blocks can be configured before they are placed.</p>}
    {selected && value ? <section aria-label={`Edit ${selected.name || "unnamed block"}`} className="settings-stack" key={selected.id}>
      <label className="config-field"><span>Block name</span><input value={selected.name} maxLength={64} onChange={(event) => onChange(updateHABlockDraft(config, { ...selected, name: event.target.value }))} /></label>
      <HABlockSettings value={value} status={status?.[selected.id]} entities={entities} loading={loading} error={error} layoutError={layoutError}
        onChange={(settings) => onChange(updateHABlockDraft(config, { ...settings, id: selected.id, name: selected.name }))} />
      <button className="button secondary" type="button" onClick={() => onChange(removeHABlockDraft(config, selected.id))}>Remove block</button>
      <p className="screen-footnote">Removing a block also removes its layout placements when you save. Discard restores both.</p>
    </section> : layoutError ? <p className="inline-message error" role="alert">{layoutError}</p> : null}
  </div>;
}
