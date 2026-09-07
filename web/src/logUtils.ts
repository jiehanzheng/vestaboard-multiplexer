import type { LogEntry, LogLevel } from "../../src/contracts/logs.js";

export interface LogFilters {
  source: string;
  level: LogLevel | "all";
  text: string;
}

export function filterLogEntries(entries: readonly LogEntry[], filters: LogFilters): LogEntry[] {
  const text = filters.text.trim().toLowerCase();
  return entries.filter((entry) => (
    (filters.source === "all" || entry.source === filters.source)
    && (filters.level === "all" || entry.level === filters.level)
    && (!text || `${entry.source} ${entry.message}`.toLowerCase().includes(text))
  ));
}

export function formatLogEntry(entry: LogEntry): string {
  return `${entry.timestamp} [${entry.level}] ${entry.source}: ${entry.message}`;
}

export interface LogDownloadPlatform {
  createObjectUrl: (content: string) => string;
  revokeObjectUrl: (url: string) => void;
  click: (url: string) => void;
}

export interface LogDownloadLifecycle {
  download: (entries: readonly LogEntry[]) => void;
  dispose: () => void;
}

export function createLogDownloadLifecycle(platform: LogDownloadPlatform): LogDownloadLifecycle {
  let currentUrl: string | undefined;

  const release = (): void => {
    if (currentUrl) {
      platform.revokeObjectUrl(currentUrl);
      currentUrl = undefined;
    }
  };

  return {
    download: (entries) => {
      release();
      const content = entries.map(formatLogEntry).join("\n") + (entries.length ? "\n" : "");
      currentUrl = platform.createObjectUrl(content);
      platform.click(currentUrl);
    },
    dispose: release
  };
}
