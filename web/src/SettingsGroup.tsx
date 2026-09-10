import type { ReactNode } from "react";

/** Shared presentation only; callers retain configuration and save ownership. */
export function SettingsGroup({ title, description, children }: { title: string; description: string; children: ReactNode }): ReactNode {
  return <section className="settings-group" aria-label={title}>
    <header><h3>{title}</h3><p>{description}</p></header>
    {children}
  </section>;
}
