import { withCodexAppServer } from "./appServer.js";

export interface LoginStatus {
  pending: boolean;
  verificationUrl?: string;
  userCode?: string;
  account?: string;
  error?: string;
}

export class CodexLogin {
  private value: LoginStatus = { pending: false };
  private abort?: AbortController;
  private task?: Promise<void>;
  private checkAbort?: AbortController;
  private checkTask?: Promise<void>;

  constructor(private readonly changed: () => void, private readonly run = withCodexAppServer) {}

  status(): LoginStatus { return { ...this.value }; }

  async check(): Promise<void> {
    if (this.value.pending || this.checkTask) return;
    const abort = new AbortController();
    this.checkAbort = abort;
    let task!: Promise<void>;
    task = (async () => {
      try {
        const result = await this.run((client) => client.readAccount({ refreshToken: false }), {
          signal: abort.signal,
          timeoutMs: 30_000
        });
        if (abort.signal.aborted) return;
        const account = result.account as { email?: unknown; type?: unknown } | undefined;
        this.value = { pending: false, account: account ? (
          typeof account.email === "string" ? account.email : "Connected"
        ) : undefined };
      } catch {
        if (!abort.signal.aborted) {
          this.value = { pending: false, error: "Could not read Codex account. Check the Codex installation and credentials." };
        }
      } finally {
        if (this.checkTask === task) {
          this.checkTask = undefined;
          this.checkAbort = undefined;
        }
        if (!abort.signal.aborted) this.changed();
      }
    })();
    this.checkTask = task;
    await task;
  }

  start(): void {
    if (this.value.pending || this.checkTask) return;
    this.abort = new AbortController();
    this.value = { pending: true };
    this.changed();
    this.task = this.login(this.abort.signal);
  }

  private async login(signal: AbortSignal): Promise<void> {
    let complete!: (success: boolean) => void;
    const completed = new Promise<boolean>((resolve) => { complete = resolve; });
    try {
      const success = await this.run(async (client) => {
        const login = await client.startDeviceLogin();
        if (signal.aborted) return false;
        const url = new URL(login.verificationUrl);
        if (url.protocol !== "https:") throw new Error("Invalid verification URL");
        this.value = { pending: true, verificationUrl: url.href, userCode: login.userCode };
        this.changed();
        return completed;
      }, {
        signal,
        timeoutMs: 15 * 60_000,
        onNotification: (method, params) => {
          if (method === "account/login/completed") {
            complete((params as { success?: boolean } | undefined)?.success === true);
          }
        }
      });
      this.value = success ? { pending: false, account: "Connected" } : {
        pending: false, error: "Login did not complete. You can try again or use mounted Codex credentials."
      };
    } catch {
      this.value = signal.aborted ? { pending: false } : {
        pending: false, error: "Login failed or expired. Enable device-code login in your ChatGPT security settings, then try again."
      };
    } finally {
      complete(false);
      this.changed();
    }
  }

  async cancel(): Promise<void> {
    this.abort?.abort();
    await this.task;
  }

  async stop(): Promise<void> {
    this.checkAbort?.abort();
    await Promise.all([this.cancel(), this.checkTask]);
  }
}
