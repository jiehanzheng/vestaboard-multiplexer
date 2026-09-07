import { useEffect, useRef, useState, type ReactNode } from "react";
import type { HAConfig } from "../../src/contracts/config";
import { testHomeAssistant } from "./api";
import { homeAssistantRequestKey } from "./haRequestIdentity";

export function HAConnectionSettings({ value, hasToken, saved, status, onChange, onTest }: {
  value: HAConfig;
  hasToken: boolean;
  saved?: boolean;
  status?: string;
  onChange: (value: HAConfig) => void;
  onTest?: (connected: boolean, error?: string) => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [feedbackTone, setFeedbackTone] = useState<"success" | "error">("success");
  const [testedKey, setTestedKey] = useState<string>();
  // Keep an omitted token (retain the saved credential) distinct from an
  // explicit empty token (clear it), so an earlier test cannot update the
  // editor after the operator clears credentials.
  const requestKey = homeAssistantRequestKey(value);
  const requestKeyRef = useRef(requestKey);
  requestKeyRef.current = requestKey;

  useEffect(() => {
    requestKeyRef.current = requestKey;
    setBusy(false);
    setFeedback(undefined);
    setTestedKey(undefined);
  }, [requestKey]);

  async function handleTest(): Promise<void> {
    const keyAtStart = requestKey;
    const credentialBody = { url: value.url, ...(value.token !== undefined ? { token: value.token } : {}) };
    setBusy(true);
    setFeedback(undefined);
    try {
      const result = await testHomeAssistant(credentialBody);
      if (requestKeyRef.current !== keyAtStart) return;
      const connected = result.connected === true;
      setFeedbackTone(connected ? "success" : "error");
      setTestedKey(keyAtStart);
      setFeedback(connected
        ? (saved ? "Connection test passed." : "Connection test passed. Save Home Assistant to use these settings.")
        : result.error ?? "Home Assistant could not be connected.");
      onTest?.(connected, result.error);
    } catch (error: unknown) {
      if (requestKeyRef.current !== keyAtStart) return;
      const message = error instanceof Error ? error.message : "Home Assistant could not be reached.";
      setFeedbackTone("error");
      setTestedKey(keyAtStart);
      setFeedback(message);
      onTest?.(false, message);
    } finally {
      if (requestKeyRef.current === keyAtStart) setBusy(false);
    }
  }

  return (
    <section className="connection-section" aria-labelledby="home-assistant-heading">
      <div className="section-heading">
        <div><h2 id="home-assistant-heading">Home Assistant</h2><p>Read-only connection for configured entities and platform signals. Tests these values without saving.</p></div>
        {status ? <span className="connection-badge">{status}</span> : null}
      </div>
      <div className="settings-panel">
        <div className="settings-grid">
          <label className="config-field">
            <span>Home Assistant URL</span>
            <input id="ha-url" type="url" value={value.url} placeholder="http://homeassistant.local:8123" onChange={(event) => onChange({ ...value, url: event.target.value })} />
          </label>
          <label className="config-field">
            <span>Long-lived access token</span>
            <input id="ha-token" type="password" value={value.token ?? ""} placeholder={hasToken ? "Saved token · type to replace" : "Paste token"} autoComplete="new-password" onChange={(event) => onChange({ ...value, token: event.target.value })} />
          </label>
        </div>
        <div className="editor-actions">
          <button className="button secondary" type="button" onClick={() => void handleTest()} disabled={busy || !value.url.trim()}>{busy ? "Testing…" : "Test connection"}</button>
          <button className="button quiet" type="button" onClick={() => onChange({ ...value, token: "" })} disabled={busy || !hasToken}>Clear saved token</button>
        </div>
        {feedback && testedKey === requestKey ? <p className={`inline-message ${feedbackTone}`} role={feedbackTone === "error" ? "alert" : "status"}>{feedback}</p> : null}
      </div>
    </section>
  );
}
