import type { ReactNode } from "react";

export function SectionSaveActions({ label, dirty, saving, saveDisabled, onSave, onDiscard }: {
  label: string;
  dirty: boolean;
  saving: boolean;
  saveDisabled?: boolean;
  onSave: () => void;
  onDiscard: () => void;
}): ReactNode {
  return (
    <div className="section-save-actions">
      <button className="button secondary" type="button" onClick={onDiscard} disabled={!dirty || saving}>Discard</button>
      <button className="button primary" type="button" onClick={onSave} disabled={!dirty || saving || saveDisabled}>{saving ? "Saving…" : `Save ${label}`}</button>
    </div>
  );
}
