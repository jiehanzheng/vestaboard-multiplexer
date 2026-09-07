import type { AppConfig, ConfigPatch, ConfigSaveResponse, PublicAppConfig } from "../../src/contracts/config.js";

export type ConfigSection = "codex" | "water" | "ha" | "pause" | "board" | "layout";

export interface SaveReconciliation<TConfig> { draftConfig: TConfig; newerEdits: boolean }

export function configPatchForSection(section: ConfigSection, config: AppConfig): ConfigPatch {
  switch (section) {
    case "codex": return { codex: structuredClone(config.codex) };
    case "water": return { water: structuredClone(config.water) };
    case "ha": return { ha: { url: config.ha.url, ...(config.ha.token !== undefined ? { token: config.ha.token } : {}) } };
    case "pause": return { ha: { pause: config.ha.pause }, pauseOverlay: structuredClone(config.pauseOverlay) };
    case "board": return {
      board: config.board,
      transport: structuredClone(config.transport),
      updateIntervalMinutes: config.updateIntervalMinutes
    };
    case "layout": return { layout: config.layout === null ? null : structuredClone(config.layout) };
  }
}

function sectionValue(section: ConfigSection, config: AppConfig | PublicAppConfig): unknown {
  switch (section) {
    case "codex": return config.codex;
    case "water": return config.water;
    case "ha": return { url: config.ha.url, token: "token" in config.ha ? config.ha.token : undefined };
    case "pause": return { pause: config.ha.pause, pauseOverlay: config.pauseOverlay };
    case "board": return { board: config.board, transport: config.transport, updateIntervalMinutes: config.updateIntervalMinutes };
    case "layout": return config.layout;
  }
}

export function sectionIsDirty(section: ConfigSection, draft: AppConfig, saved: PublicAppConfig): boolean {
  return JSON.stringify(sectionValue(section, draft)) !== JSON.stringify(sectionValue(section, saved));
}

export function replaceSection(draft: AppConfig, saved: PublicAppConfig, section: ConfigSection): AppConfig {
  const next = structuredClone(draft);
  switch (section) {
    case "codex": next.codex = structuredClone(saved.codex); break;
    case "water": next.water = structuredClone(saved.water); break;
    case "ha": next.ha = { url: saved.ha.url, pause: next.ha.pause }; break;
    case "pause": next.ha.pause = structuredClone(saved.ha.pause); next.pauseOverlay = structuredClone(saved.pauseOverlay); break;
    case "board":
      next.board = saved.board;
      next.transport = structuredClone(saved.transport) as AppConfig["transport"];
      next.updateIntervalMinutes = saved.updateIntervalMinutes;
      break;
    case "layout": next.layout = saved.layout === null ? null : structuredClone(saved.layout); break;
  }
  return next;
}

export function reconcileSectionSave(input: {
  section: ConfigSection;
  acknowledgement: ConfigSaveResponse;
  submittedDraft: AppConfig;
  currentDraft: AppConfig;
}): SaveReconciliation<AppConfig> {
  const newerEdits = JSON.stringify(sectionValue(input.section, input.currentDraft)) !== JSON.stringify(sectionValue(input.section, input.submittedDraft));
  if (newerEdits) return { draftConfig: input.currentDraft, newerEdits };
  return { draftConfig: replaceSection(input.currentDraft, input.acknowledgement.config, input.section), newerEdits };
}
