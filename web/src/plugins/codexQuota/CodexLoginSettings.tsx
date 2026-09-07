import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LoginStatus } from "../../../../src/contracts/api";
import { cancelLogin, checkLogin, startLogin } from "../../api";

export function CodexLoginSettings({ login, quotaError, onLogin, onNotice, settings }: { login: LoginStatus; quotaError?: string; onLogin: (status: LoginStatus) => void; onNotice: (notice: { tone: "success" | "error" | "info"; message: string } | undefined) => void; settings?: ReactNode }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [hasChecked, setHasChecked] = useState(Boolean(login.account || login.error));
  const [checkError, setCheckError] = useState<string>();
  const mountedRef = useRef(false);
  const automaticCheckRef = useRef<Promise<LoginStatus> | undefined>(undefined);

  useEffect(() => {
    let active = true;
    mountedRef.current = true;
    if (!login.pending && !automaticCheckRef.current) {
      setChecking(true);
      automaticCheckRef.current = checkLogin();
    }
    const request = automaticCheckRef.current;
    if (request) {
      void request
        .then((nextLogin) => {
          if (!active) return;
          setHasChecked(true);
          setCheckError(undefined);
          onLogin(nextLogin);
        })
        .catch((error: unknown) => {
          if (!active) return;
          const message = error instanceof Error ? error.message : "Could not read Codex account.";
          setHasChecked(true);
          setCheckError(message);
        })
        .finally(() => {
          if (active) setChecking(false);
        });
    }
    return () => {
      active = false;
      mountedRef.current = false;
    };
  }, []);

  const act = async (operation: () => Promise<LoginStatus>, success?: string, statusCheck = false) => {
    setBusy(true);
    onNotice(undefined);
    setCheckError(undefined);
    try {
      const nextLogin = await operation();
      if (!mountedRef.current) return;
      setHasChecked(true);
      if (statusCheck) setCheckError(undefined);
      onLogin(nextLogin);
      if (success) onNotice({ tone: "success", message: success });
    } catch (error: unknown) {
      if (!mountedRef.current) return;
      const message = error instanceof Error ? error.message : "Could not update Codex login.";
      if (statusCheck) {
        setHasChecked(true);
        setCheckError(message);
      }
      onNotice({ tone: "error", message });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };
  const error = login.error ?? checkError;
  const attention = error ?? quotaError;
  const intro = checking
    ? "Checking mounted Codex credentials for quota access."
    : login.account
      ? quotaError ? "Codex account is connected, but quota updates need attention." : "Usage and quota updates are ready."
      : error
        ? "Codex account status could not be verified."
        : hasChecked
          ? "Sign in with Codex to read usage and quota updates."
          : "Checking for mounted Codex credentials…";
  const badge = checking
    ? "Checking account…"
    : login.account
      ? attention ? "Needs attention" : "Account connected"
      : login.pending
        ? "Sign-in pending"
        : error
          ? "Account check failed"
          : hasChecked
            ? "Signed out"
            : "Account not checked";
  const badgeClass = login.account && !attention ? "connection-badge good" : login.pending || checking ? "connection-badge pending" : attention ? "connection-badge error" : "connection-badge";
  return (
    <section className="connection-section" aria-labelledby="codex-heading">
      <div className="section-heading">
        <div><h2 id="codex-heading">Account</h2><p>{intro}</p></div>
        <span className={badgeClass}>{badge}</span>
      </div>
      <div className="login-panel">
        {login.pending && login.userCode ? <code className="device-code">{login.userCode}</code> : <span className="login-state">{checking ? "Checking mounted Codex credentials…" : login.account ? login.account : login.pending ? "Preparing device sign-in…" : error ? "Could not verify the Codex account." : hasChecked ? "No Codex account is connected." : "Check status to verify the account"}</span>}
        <div className="login-actions">
          {login.pending && login.verificationUrl ? <a className="button secondary" href={login.verificationUrl} target="_blank" rel="noreferrer">Open device sign-in</a> : login.account ? <button className="button secondary" onClick={() => void act(startLogin)} disabled={busy || checking}>{busy ? "Switching…" : "Switch account"}</button> : !error && hasChecked ? <button className="button secondary" onClick={() => void act(startLogin)} disabled={busy || checking}>{busy ? "Starting…" : "Start device sign-in"}</button> : null}
          {login.pending ? <button className="button quiet" onClick={() => void act(cancelLogin, "Device sign-in cancelled.")} disabled={busy}>Cancel</button> : <button className="button quiet" onClick={() => void act(checkLogin, undefined, true)} disabled={busy || checking}>{checking ? "Checking…" : error ? "Retry status check" : "Check status"}</button>}
        </div>
        <span className={checking || login.pending || quotaError ? "login-helper" : "login-helper muted"}>{checking ? "Reading mounted credentials" : login.pending ? "Waiting for approval" : quotaError ? `Quota: ${quotaError}` : error ?? ""}</span>
      </div>
      {error ? <p className="inline-message error" role="alert">{error}</p> : null}
      {quotaError ? <p className="inline-message warning" role="status">Quota updates: {quotaError}</p> : null}
      {settings ? <div className="settings-panel codex-settings-panel" aria-label="Codex quota settings">
        <div className="subheading-row"><h3>Quota settings</h3></div>
        <p className="screen-footnote">Choose how Codex collects and displays usage for board rows.</p>
        <div className="settings-grid">{settings}</div>
      </div> : null}
    </section>
  );
}
