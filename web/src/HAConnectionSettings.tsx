import { useState, type ReactNode } from "react";
import type { HAConfig } from "../../src/contracts/config";
import { testHomeAssistant } from "./api";

export function HAConnectionSettings({ value, hasToken, onChange, onTest }: {
  value: HAConfig;
  hasToken: boolean;
  onChange: (value: HAConfig) => void;
  onTest?: (connected: boolean, error?: string) => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [feedbackTone, setFeedbackTone] = useState<"success" | "error">("success");
  const credentialBody = { url: value.url, ...(value.token ? { token: value.token } : {}) };

  async function handleTest(): Promise<void> {
    setBusy(true);
    setFeedback(undefined);
    try {
      const result = await testHomeAssistant(credentialBody);
      const connected = result.connected === true;
      setFeedbackTone(connected ? "success" : "error");
      setFeedback(connected ? "Home Assistant connection is ready." : result.error ?? "Home Assistant could not be connected.");
      onTest?.(connected, result.error);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Home Assistant could not be reached.";
      setFeedbackTone("error");
      setFeedback(message);
      onTest?.(false, message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="connection-section" aria-labelledby="home-assistant-heading">
      <div className="section-heading">
        <div><h2 id="home-assistant-heading">Home Assistant</h2><p>Read-only connection for configured entities and platform signals.</p></div>
        <span className="connection-badge">Read only</span>
      </div>
      <div className="settings-panel">
        <div className="settings-grid">
          <label className="config-field">
            <span>Home Assistant URL</span>
            <input id="ha-url" type="url" value={value.url} placeholder="http://homeassistant.local:8123" onChange={(event) => onChange({ ...value, url: event.target.value })} />
          </label>
          <label className="config-field">
            <span>Long-lived access token</span>
            <input id="ha-token" type="password" value={value.token ?? ""} placeholder={hasToken ? "Saved token · type to replace" : "Paste token"} autoComplete="new-password" onChange={(event) => onChange({ ...value, token: event.target.value || undefined })} />
          </label>
        </div>
        <div className="editor-actions">
          <button className="button secondary" type="button" onClick={() => void handleTest()} disabled={busy || !value.url.trim()}>{busy ? "Testing…" : "Test connection"}</button>
        </div>
        {feedback ? <p className={`inline-message ${feedbackTone}`} role={feedbackTone === "error" ? "alert" : "status"}>{feedback}</p> : null}
      </div>
    </section>
  );
}
