import { useState, type ReactNode } from "react";
import type { LoginStatus } from "../../../../src/contracts/api";
import { cancelLogin, checkLogin, startLogin } from "../../api";

export function CodexLoginSettings({ login, onLogin, onNotice }: { login: LoginStatus; onLogin: (status: LoginStatus) => void; onNotice: (notice: { tone: "success" | "error" | "info"; message: string } | undefined) => void }): ReactNode {
  const [busy, setBusy] = useState(false);
  const act = async (operation: () => Promise<LoginStatus>, success?: string) => {
    setBusy(true);
    onNotice(undefined);
    try {
      const nextLogin = await operation();
      onLogin(nextLogin);
      if (success) onNotice({ tone: "success", message: success });
    } catch (error: unknown) {
      onNotice({ tone: "error", message: error instanceof Error ? error.message : "Could not update Codex login." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="connection-section" aria-labelledby="codex-heading">
      <div className="section-heading">
        <div><h2 id="codex-heading">Codex</h2><p>Sign in to read usage and quota updates.</p></div>
        <span className={login.account ? "connection-badge good" : login.pending ? "connection-badge pending" : login.error ? "connection-badge" : "connection-badge"}>{login.account ? "Account connected" : login.pending ? "Sign-in pending" : login.error ? "Not connected" : "Account not checked"}</span>
      </div>
      <div className="login-panel">
        {login.pending && login.userCode ? <code className="device-code">{login.userCode}</code> : <span className="login-state">{login.account ? login.account : login.pending ? "Preparing device sign-in…" : login.error ? "Codex account not connected" : "Check status to verify the account"}</span>}
        <div className="login-actions">
          {login.pending && login.verificationUrl ? <a className="button secondary" href={login.verificationUrl} target="_blank" rel="noreferrer">Open device sign-in</a> : <button className="button secondary" onClick={() => void act(startLogin)} disabled={busy}>{busy ? "Starting…" : "Start device sign-in"}</button>}
          {login.pending ? <button className="button quiet" onClick={() => void act(cancelLogin, "Device sign-in cancelled.")} disabled={busy}>Cancel</button> : <button className="button quiet" onClick={() => void act(checkLogin)} disabled={busy}>Check status</button>}
        </div>
        <span className={login.pending ? "login-helper" : "login-helper muted"}>{login.pending ? "Waiting for approval" : login.error ?? ""}</span>
      </div>
      {login.error ? <p className="inline-message error" role="alert">{login.error}</p> : null}
    </section>
  );
}
