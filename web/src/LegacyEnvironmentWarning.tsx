import type { ReactNode } from "react";

export function LegacyEnvironmentWarning({ names }: { names: readonly string[] }): ReactNode {
  if (names.length === 0) return null;
  return (
    <details className="legacy-warning" role="status">
      <summary><strong>Legacy environment settings detected</strong></summary>
      <p>Remove these variables from your deployment environment and restart vbmux. Saved settings control the app; these variables no longer override them.</p>
      <code>{names.join(", ")}</code>
    </details>
  );
}
