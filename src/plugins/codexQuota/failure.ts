import { constants, accessSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CodexAppServerError } from "./appServer.js";

export type CodexFailureReason =
  | "auth_expired"
  | "auth_required"
  | "rate_limit"
  | "timeout"
  | "invalid_json"
  | "app_server_exited"
  | "app_server_start_failed"
  | "bubblewrap"
  | "unknown";

export interface CodexFailure {
  reason: CodexFailureReason;
  boardStatus: string;
  authenticationFailure: boolean;
}

export interface CodexAuthStorageDiagnostics {
  authFile: string;
  authFilePresent: boolean;
  authFileReadable: boolean;
  authFileWritable: boolean;
  authDirectoryWritable: boolean;
  authFileModifiedAt?: string;
}

interface AuthStorageInspectionOptions {
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  exists?: (path: string) => boolean;
  access?: (path: string, mode: number) => void;
  modifiedAt?: (path: string) => Date;
}

export class CodexAuthRefreshError extends Error {
  constructor(
    readonly initialError: unknown,
    readonly refreshError: unknown
  ) {
    super(`Codex authentication refresh failed: ${errorDetail(refreshError)}`, {
      cause: refreshError instanceof Error ? refreshError : undefined
    });
    this.name = "CodexAuthRefreshError";
  }
}

export function classifyCodexFailure(error: unknown): CodexFailure {
  if (error instanceof CodexAuthRefreshError) {
    const initial = classifyCodexFailure(error.initialError);
    if (initial.authenticationFailure) {
      return initial;
    }
  }

  const normalized = errorDetail(error).toUpperCase();
  if (normalized.includes("TOKEN_EXPIRED")) {
    return failure("auth_expired", "AUTH EXPIRED", true);
  }
  if (/\b401\b/.test(normalized) || normalized.includes("UNAUTHORIZED")) {
    return failure("auth_required", "LOGIN NEEDED", true);
  }
  // The endpoint name contains "rate limits", so only protocol-level limit signals are authoritative.
  if (/\b429\b/.test(normalized)
    || normalized.includes("RATE_LIMIT_EXCEEDED")
    || normalized.includes("TOO_MANY_REQUESTS")) {
    return failure("rate_limit", "RATE LIMIT", false);
  }
  if (normalized.includes("TIMED OUT") || normalized.includes("TIMEOUT")) {
    return failure("timeout", "TIMEOUT", false);
  }
  if (normalized.includes("INVALID JSON")) {
    return failure("invalid_json", "BAD JSON", false);
  }
  if (normalized.includes("EXITED")) {
    return failure("app_server_exited", "EXIT", false);
  }
  if (normalized.includes("COULD NOT START")) {
    return failure("app_server_start_failed", "START", false);
  }
  if (normalized.includes("BUBBLEWRAP")) {
    return failure("bubblewrap", "BWRAP", false);
  }
  return failure("unknown", "FETCH FAIL", false);
}

export function isCodexAuthenticationFailure(error: unknown): boolean {
  return classifyCodexFailure(error).authenticationFailure;
}

export function inspectCodexAuthStorage({
  env = process.env,
  homeDirectory = homedir(),
  exists = existsSync,
  access = accessSync,
  modifiedAt = (path) => statSync(path).mtime
}: AuthStorageInspectionOptions = {}): CodexAuthStorageDiagnostics {
  const codexHome = env.CODEX_HOME ?? join(homeDirectory, ".codex");
  const authFile = join(codexHome, "auth.json");
  const authFilePresent = exists(authFile);

  return {
    authFile,
    authFilePresent,
    authFileReadable: authFilePresent && canAccess(access, authFile, constants.R_OK),
    authFileWritable: authFilePresent && canAccess(access, authFile, constants.W_OK),
    // Codex may replace auth.json atomically, which also requires a writable parent directory.
    authDirectoryWritable: exists(codexHome) && canAccess(access, codexHome, constants.W_OK),
    authFileModifiedAt: authFilePresent ? safeModifiedAt(modifiedAt, authFile)?.toISOString() : undefined
  };
}

export function codexAppServerErrorDetails(error: unknown): {
  rpcCode?: number;
  rpcMessage?: string;
} | undefined {
  const appServerError = unwrapAppServerError(error);
  return appServerError
    ? { rpcCode: appServerError.rpcCode, rpcMessage: appServerError.rpcMessage }
    : undefined;
}

function unwrapAppServerError(error: unknown): CodexAppServerError | undefined {
  if (error instanceof CodexAppServerError) {
    return error;
  }
  if (error instanceof CodexAuthRefreshError) {
    return unwrapAppServerError(error.refreshError) ?? unwrapAppServerError(error.initialError);
  }
  return undefined;
}

function errorDetail(error: unknown): string {
  if (error instanceof CodexAppServerError) {
    return JSON.stringify(error.rpcError);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function failure(reason: CodexFailureReason, boardStatus: string, authenticationFailure: boolean): CodexFailure {
  return { reason, boardStatus, authenticationFailure };
}

function canAccess(access: (path: string, mode: number) => void, path: string, mode: number): boolean {
  try {
    access(path, mode);
    return true;
  } catch {
    return false;
  }
}

function safeModifiedAt(modifiedAt: (path: string) => Date, path: string): Date | undefined {
  try {
    return modifiedAt(path);
  } catch {
    return undefined;
  }
}
