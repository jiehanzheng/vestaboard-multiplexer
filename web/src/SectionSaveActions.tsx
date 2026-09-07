import type { ReactNode } from "react";
import type { Notice } from "./notice";

export function SectionSaveActions({ label, dirty, saving, saveDisabled, feedback, onSave, onDiscard }: {
  label: string;
  dirty: boolean;
  saving: boolean;
  saveDisabled?: boolean;
  feedback?: Exclude<Notice, undefined>;
  onSave: () => void;
  onDiscard: () => void;
}): ReactNode {
  return (
    <div className="section-save-actions">
      <div className="section-save-buttons">
        <button className="button secondary" type="button" onClick={onDiscard} disabled={!dirty || saving}>Discard</button>
        <button className="button primary" type="button" onClick={onSave} disabled={!dirty || saving || saveDisabled}>{saving ? "Saving…" : `Save ${label}`}</button>
      </div>
      <span className="section-save-state" aria-live="polite">{saving ? "Saving changes…" : dirty ? "Unsaved changes" : "Saved"}</span>
      {feedback ? <p className={`inline-message ${feedback.tone}`} role={feedback.tone === "error" ? "alert" : "status"}>{feedback.message}</p> : null}
    </div>
  );
}
