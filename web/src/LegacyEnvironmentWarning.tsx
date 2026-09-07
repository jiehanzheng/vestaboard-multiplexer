import type { ReactNode } from "react";

export function LegacyEnvironmentWarning({ names }: { names: readonly string[] }): ReactNode {
  if (names.length === 0) return null;
  return (
    <aside className="legacy-warning" role="status">
      <strong>Legacy environment settings detected</strong>
      <p>These settings were imported or are obsolete. Edit the saved configuration to manage them here.</p>
      <code>{names.join(", ")}</code>
    </aside>
  );
}
