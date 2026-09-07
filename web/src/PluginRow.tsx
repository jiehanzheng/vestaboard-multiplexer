import type { ReactNode } from "react";

export function PluginRow({ title, purpose, status, dirty, onOpen }: {
  title: string;
  purpose: string;
  status: string;
  dirty?: boolean;
  onOpen: () => void;
}): ReactNode {
  return (
    <button className="plugin-row" type="button" onClick={onOpen} aria-label={`Open ${title} plugin`}>
      <span className="plugin-row-copy"><strong>{title}</strong><span>{purpose}</span></span>
      <span className={`connection-badge ${dirty ? "pending" : ""}`}>{dirty ? "Unsaved changes" : status}</span>
      <span className="plugin-row-open" aria-hidden="true">›</span>
    </button>
  );
}
