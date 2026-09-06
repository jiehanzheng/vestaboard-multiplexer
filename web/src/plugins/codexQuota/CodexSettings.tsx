import type { ReactNode } from "react";
import type { CodexConfig } from "../../../src/contracts/config";
import { ConfigNumber, ConfigToggle } from "../../ConfigControls";
import { isLocked } from "../../utils";

export function CodexSettings({ value, locked, onChange }: { value: CodexConfig; locked: readonly string[]; onChange: (value: CodexConfig) => void }): ReactNode {
  const update = (patch: Partial<CodexConfig>) => onChange({ ...value, ...patch });
  return (
    <>
      <ConfigNumber label="Poll interval (seconds)" value={String(value.pollIntervalSeconds)} locked={isLocked([...locked], ["codex.pollIntervalSeconds"])} onChange={(pollIntervalSeconds) => update({ pollIntervalSeconds })} />
      <ConfigToggle label="Show pacing" checked={value.showPacing} locked={isLocked([...locked], ["codex.showPacing"])} onChange={(showPacing) => update({ showPacing })} />
      <ConfigToggle label="Auto-start 5h window" checked={value.autoStartWindow5h} locked={isLocked([...locked], ["codex.autoStartWindow5h"])} onChange={(autoStartWindow5h) => update({ autoStartWindow5h })} />
      <ConfigToggle label="Auto-start weekly window" checked={value.autoStartWindowWk} locked={isLocked([...locked], ["codex.autoStartWindowWk"])} onChange={(autoStartWindowWk) => update({ autoStartWindowWk })} />
    </>
  );
}
