import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

type JsonObject = Record<string, unknown>;
type CodexAppServerOperation<T> = (client: CodexLoginClient) => Promise<T>;
type ResponseParser<T> = (value: unknown) => T;

const APP_SERVER_TIMEOUT_MS = 30_000;

export interface CodexAppServerClient {
  readAccount(params: AccountReadParams): Promise<AccountReadResult>;
  readRateLimits(): Promise<RateLimitsResult>;
  readModels(params: ModelListParams): Promise<ModelListResult>;
  startThread(params: ThreadStartParams): Promise<ThreadStartResult>;
  startTurn(params: TurnStartParams): Promise<TurnStartResult>;
  waitForTurnCompletion(threadId: string, turnId: string): Promise<void>;
}

export interface DeviceLogin {
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface CodexLoginClient extends CodexAppServerClient {
  startDeviceLogin(): Promise<DeviceLogin>;
  cancelLogin(loginId: string): Promise<unknown>;
}

export interface AccountReadParams {
  refreshToken: boolean;
}

export interface AccountReadResult {
  account?: unknown;
  requiresOpenaiAuth: boolean;
}

export class CodexAppServerError extends Error {
  readonly rpcCode?: number;
  readonly rpcMessage?: string;
  readonly rpcData?: unknown;

  constructor(readonly rpcError: unknown) {
    const fields = objectFields(rpcError);
    super(`Codex app-server error: ${JSON.stringify(rpcError)}`);
    this.name = "CodexAppServerError";
    this.rpcCode = typeof fields?.code === "number" ? fields.code : undefined;
    this.rpcMessage = typeof fields?.message === "string" ? fields.message : undefined;
    this.rpcData = fields?.data;
  }
}

export interface RateWindow {
  usedPercent: number;
  windowDurationMins?: number | null;
  resetsAt?: number | null;
}

export interface RateLimitBucket {
  limitId: string;
  limitName?: string | null;
  primary?: RateWindow | null;
  secondary?: RateWindow | null;
}

export interface RateLimitsResult {
  rateLimits?: RateLimitBucket | null;
  rateLimitsByLimitId?: Record<string, RateLimitBucket> | null;
  rateLimitResetCredits?: {
    availableCount?: number | null;
  } | null;
}

export interface ModelListParams {
  limit: number;
  includeHidden: boolean;
  cursor?: string | null;
}

export interface ModelListResult {
  data: CodexModel[];
  nextCursor?: string | null;
}

export interface CodexModel {
  id: string;
  model: string;
  supportedReasoningEfforts: ReasoningEffortOption[];
}

interface ReasoningEffortOption {
  reasoningEffort: string;
}

export interface ThreadStartParams {
  model: string;
  approvalPolicy: string;
  sandbox: string;
  baseInstructions: string;
  ephemeral: boolean;
  threadSource: string;
}

export interface ThreadStartResult {
  thread: {
    id: string;
  };
}

export interface TurnStartParams {
  threadId: string;
  input: Array<{ type: string; text: string; text_elements: unknown[] }>;
  model: string;
  effort: string;
  approvalPolicy: string;
}

export interface TurnStartResult {
  turn: {
    id: string;
    status: string;
  };
}

export function isMatchingTurnCompletion(
  params: { threadId?: string; turn?: { id?: string } } | undefined,
  threadId: string,
  turnId: string
): boolean {
  const matchesThread = params?.threadId === undefined || params.threadId === threadId;
  const matchesTurn = params?.turn?.id === turnId;
  return matchesThread && matchesTurn;
}

export function turnCompletionFailure(turn: { status?: string; error?: unknown }): Error | undefined {
  if (turn.status === "completed") {
    return undefined;
  }

  return new Error(`Codex auto-start turn ended with status ${turn.status ?? "unknown"}: ${JSON.stringify(turn.error)}`);
}

export async function withCodexAppServer<T>(operation: CodexAppServerOperation<T>, options: {
  timeoutMs?: number;
  signal?: AbortSignal;
  onNotification?: (method: string, params: unknown) => void;
} = {}): Promise<T> {
  const proc = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "inherit"] });
  if (!proc.stdin || !proc.stdout) {
    throw new Error("Could not open Codex app-server pipes.");
  }

  const lines = createInterface({ input: proc.stdout });
  let nextId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const notificationListeners = new Set<(message: { method: string; params?: unknown }) => void>();
  const notificationRejecters = new Set<(error: Error) => void>();
  let cleanedUp = false;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
  void failure.catch(() => {});

  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
    lines.removeAllListeners();
    lines.close();
    proc.removeAllListeners("error");
    proc.removeAllListeners("exit");

    if (!proc.stdin.destroyed) {
      proc.stdin.end();
    }

    if (proc.exitCode === null && !proc.killed) {
      proc.kill();
    }
  };

  const fail = (error: Error): void => {
    rejectFailure(error);
    for (const entry of pending.values()) {
      entry.reject(error);
    }
    pending.clear();
    for (const reject of notificationRejecters.values()) {
      reject(error);
    }
    notificationRejecters.clear();
    cleanup();
  };

  const onAbort = (): void => fail(new Error("Codex operation cancelled."));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = options.timeoutMs ?? APP_SERVER_TIMEOUT_MS;
  const timeout = setTimeout(() => {
    fail(new Error(`Codex app-server timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  const send = (message: object): void => {
    proc.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const request = <T>(method: string, params: object | undefined, parse: ResponseParser<T>): Promise<T> => {
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: (value) => {
          try {
            resolve(parse(value));
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        reject
      });
      send(params ? { method, id, params } : { method, id });
    });
  };

  const waitForTurnCompletion = (threadId: string, turnId: string): Promise<void> => new Promise((resolve, reject) => {
    const listener = (message: { method: string; params?: unknown }): void => {
      if (message.method !== "turn/completed") {
        return;
      }

      const params = message.params as { threadId?: string; turn?: { id?: string; status?: string; error?: unknown } } | undefined;
      const turn = params?.turn;
      if (!turn || !isMatchingTurnCompletion(params, threadId, turnId)) {
        return;
      }

      notificationListeners.delete(listener);
      notificationRejecters.delete(reject);
      const failure = turnCompletionFailure(turn);
      if (failure) {
        reject(failure);
      } else {
        resolve();
      }
    };
    notificationListeners.add(listener);
    notificationRejecters.add(reject);
  });

  const client: CodexLoginClient = {
    startDeviceLogin: () => request("account/login/start", { type: "chatgptDeviceCode" }, (value) => {
      const result = asObject(value, "device login");
      return {
        loginId: requiredString(result.loginId, "login id"),
        verificationUrl: requiredString(result.verificationUrl, "verification URL"),
        userCode: requiredString(result.userCode, "user code")
      };
    }),
    cancelLogin: (loginId) => request("account/login/cancel", { loginId }, (value) => value),
    readAccount: (params) => request("account/read", params, parseAccountReadResult),
    readRateLimits: () => request("account/rateLimits/read", undefined, parseRateLimitsResult),
    readModels: (params) => request("model/list", params, parseModelListResult),
    startThread: (params) => request("thread/start", params, parseThreadStartResult),
    startTurn: (params) => request("turn/start", params, parseTurnStartResult),
    waitForTurnCompletion
  };

  lines.on("line", (line) => {
    let message: { id?: number; method?: string; result?: unknown; error?: unknown };
    try {
      message = JSON.parse(line);
    } catch {
      fail(new Error(`Invalid JSON from Codex: ${line}`));
      return;
    }

    if (message.method !== undefined) {
      options.onNotification?.(message.method, (message as { params?: unknown }).params);
      notificationListeners.forEach((listener) => listener({ method: message.method as string, params: (message as { params?: unknown }).params }));
      return;
    }

    if (message.id === undefined) {
      return;
    }

    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }

    pending.delete(message.id);
    if (message.error !== undefined) {
      entry.reject(new CodexAppServerError(message.error));
    } else {
      entry.resolve(message.result);
    }
  });

  proc.on("error", (error) => fail(new Error(`Could not start Codex: ${error.message}`)));
  proc.on("exit", (code, signal) => {
    if (!cleanedUp) {
      fail(new Error(`Codex app-server exited before responding: code=${code}, signal=${signal}`));
    }
  });

  try {
    if (options.signal?.aborted) throw new Error("Codex operation cancelled.");
    await request("initialize", {
      clientInfo: {
        name: "vestaboard_multiplexer",
        title: "Vestaboard Multiplexer",
        version: "0.1.0"
      }
    }, parseInitializeResult);
    send({ method: "initialized", params: {} });
    return await Promise.race([operation(client), failure]);
  } finally {
    cleanup();
  }
}

function parseInitializeResult(value: unknown): unknown {
  return value;
}

function parseAccountReadResult(value: unknown): AccountReadResult {
  const result = asObject(value, "account/read result");
  if (typeof result.requiresOpenaiAuth !== "boolean") {
    throw new Error("account/read result must include requiresOpenaiAuth.");
  }

  return {
    account: result.account,
    requiresOpenaiAuth: result.requiresOpenaiAuth
  };
}

function parseRateLimitsResult(value: unknown): RateLimitsResult {
  return asObject(value, "account/rateLimits/read result") as unknown as RateLimitsResult;
}

export function parseModelListResult(value: unknown): ModelListResult {
  const result = asObject(value, "model/list result");
  if (!Array.isArray(result.data)) {
    throw new Error("Codex model/list result must include a data array.");
  }

  return {
    data: result.data.map(parseCodexModel),
    nextCursor: optionalStringOrNull(result.nextCursor, "model/list nextCursor")
  };
}

function parseCodexModel(value: unknown): CodexModel {
  const model = asObject(value, "Codex model");
  const supportedReasoningEfforts = model.supportedReasoningEfforts ?? [];
  if (!Array.isArray(supportedReasoningEfforts)) {
    throw new Error("Codex model supportedReasoningEfforts must be an array when present.");
  }

  return {
    id: requiredString(model.id, "Codex model id"),
    model: requiredString(model.model, "Codex model name"),
    supportedReasoningEfforts: supportedReasoningEfforts.map((effort) => ({
      reasoningEffort: requiredString(asObject(effort, "reasoning effort").reasoningEffort, "reasoning effort")
    }))
  };
}

function parseThreadStartResult(value: unknown): ThreadStartResult {
  const result = asObject(value, "thread/start result");
  const thread = asObject(result.thread, "thread/start thread");
  return { thread: { id: requiredString(thread.id, "thread id") } };
}

function parseTurnStartResult(value: unknown): TurnStartResult {
  const result = asObject(value, "turn/start result");
  const turn = asObject(result.turn, "turn/start turn");
  return {
    turn: {
      id: requiredString(turn.id, "turn id"),
      status: requiredString(turn.status, "turn status")
    }
  };
}

function asObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value as JsonObject;
}

function objectFields(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value;
}

function optionalStringOrNull(value: unknown, label: string): string | null | undefined {
  if (value === undefined || value === null || typeof value === "string") {
    return value;
  }

  throw new Error(`${label} must be a string, null, or undefined.`);
}
