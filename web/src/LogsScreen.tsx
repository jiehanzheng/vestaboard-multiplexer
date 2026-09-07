import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LogEntry, LogLevel } from "../../src/contracts/logs.js";
import { createLogDownloadLifecycle, filterLogEntries, type LogDownloadLifecycle } from "./logUtils";

export function LogsScreen({ entries, source, connected, onBack }: { entries: readonly LogEntry[]; source?: string; connected: boolean; onBack: () => void }): ReactNode {
  const [sourceFilter, setSourceFilter] = useState(source ?? "all");
  const [level, setLevel] = useState<LogLevel | "all">("all");
  const [text, setText] = useState("");
  const [follow, setFollow] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);
  const downloadLifecycleRef = useRef<LogDownloadLifecycle | null>(null);
  if (!downloadLifecycleRef.current) {
    downloadLifecycleRef.current = createLogDownloadLifecycle({
      createObjectUrl: (content) => URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" })),
      revokeObjectUrl: (url) => URL.revokeObjectURL(url),
      click: (url) => {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "vbmux-logs.txt";
        anchor.style.display = "none";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
      }
    });
  }
  const sources = useMemo(() => ["all", ...Array.from(new Set([source, sourceFilter, ...entries.map((entry) => entry.source)].filter((item): item is string => Boolean(item) && item !== "all"))).sort()], [entries, source, sourceFilter]);
  const displayed = useMemo(() => filterLogEntries(entries, { source: sourceFilter, level, text }), [entries, level, sourceFilter, text]);

  useEffect(() => {
    setSourceFilter(source ?? "all");
  }, [source]);

  useEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [displayed, follow]);

  useEffect(() => () => downloadLifecycleRef.current?.dispose(), []);

  return <section className="logs-screen" aria-labelledby="logs-heading">
    <div className="page-heading">
      <div><button className="back-link" type="button" onClick={onBack}>← Back to Settings</button><h1 id="logs-heading">Logs</h1><p>Current run, retaining the latest 200 entries. Docker deployments keep older history in the container logs.</p></div>
      <span className={connected ? "health-badge good" : "health-badge"}>{connected ? "Live" : "Reconnecting"}</span>
    </div>
    <div className="logs-controls" aria-label="Log filters">
      <label className="config-field"><span>Source</span><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>{sources.map((item) => <option key={item} value={item}>{item === "all" ? "All sources" : item}</option>)}</select></label>
      <label className="config-field"><span>Severity</span><select value={level} onChange={(event) => setLevel(event.target.value as LogLevel | "all")}><option value="all">All levels</option><option value="info">Info</option><option value="warn">Warning</option><option value="error">Error</option></select></label>
      <label className="config-field"><span>Text</span><input type="search" value={text} placeholder="Filter messages" onChange={(event) => setText(event.target.value)} /></label>
      <label className="config-toggle logs-follow"><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /><span>Follow</span></label>
      <button className="button secondary" type="button" onClick={() => downloadLifecycleRef.current?.download(displayed)} disabled={displayed.length === 0}>Download displayed</button>
    </div>
    <div className="logs-list" ref={listRef} role="log" aria-live={follow ? "polite" : "off"} aria-label="Application logs">
      {displayed.length > 0 ? displayed.map((entry, index) => <p className={`log-entry ${entry.level}`} key={`${entry.timestamp}-${entry.source}-${index}`}><time dateTime={entry.timestamp}>{entry.timestamp}</time><strong>{entry.source}</strong><span className="log-level">{entry.level}</span><span>{entry.message}</span></p>) : <p className="empty-rows">{entries.length === 0 ? "No log entries have been recorded in this run." : "No log entries match these filters."}</p>}
    </div>
  </section>;
}
