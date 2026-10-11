import { HA_BLOCK_ELEMENT_ID, type HABlockConfig } from "../../src/plugins/haBlock/config.js";
import type { AppConfig, ConfigPatch, ConfigSaveResponse, PublicAppConfig } from "../../src/contracts/config.js";

export type ConfigSection = "codex" | "water" | "haBlock" | "ha" | "pause" | "board" | "layout";

export interface SaveReconciliation<TConfig> { draftConfig: TConfig; newerEdits: boolean }

export function configPatchForSection(section: ConfigSection, config: AppConfig): ConfigPatch {
  switch (section) {
    case "codex": return { codex: structuredClone(config.codex) };
    case "water": return { water: structuredClone(config.water) };
    case "ha": return { ha: { url: config.ha.url, ...(config.ha.token !== undefined ? { token: config.ha.token } : {}) } };
    case "pause": return {
      ha: { pause: config.ha.pause },
      pauseOverlay: structuredClone(config.pauseOverlay),
      transport: { pauseMessageTransition: config.transport.pauseMessageTransition ?? null }
    };
    case "board": return {
      board: config.board,
      transport: (() => {
        const { pauseMessageTransition: _pauseMessageTransition, ...transport } = structuredClone(config.transport);
        return transport;
      })(),
      updateIntervalMinutes: config.updateIntervalMinutes
    };
    case "haBlock":
    case "layout": return { layout: config.layout === null ? null : structuredClone(config.layout), haBlock: structuredClone(config.haBlock) };
  }
}

function sectionValue(section: ConfigSection, config: AppConfig | PublicAppConfig): unknown {
  switch (section) {
    case "codex": return config.codex;
    case "water": return config.water;
    case "ha": return { url: config.ha.url, token: "token" in config.ha ? config.ha.token : undefined };
    case "pause": return { pause: config.ha.pause, pauseOverlay: config.pauseOverlay, pauseMessageTransition: config.transport.pauseMessageTransition };
    case "board": {
      const { pauseMessageTransition: _pauseMessageTransition, ...transport } = config.transport;
      return { board: config.board, transport, updateIntervalMinutes: config.updateIntervalMinutes };
    }
    case "haBlock":
    case "layout": return { layout: config.layout, haBlock: config.haBlock };
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
    case "pause":
      next.ha.pause = structuredClone(saved.ha.pause);
      next.pauseOverlay = structuredClone(saved.pauseOverlay);
      next.transport.pauseMessageTransition = saved.transport.pauseMessageTransition === undefined ? undefined : structuredClone(saved.transport.pauseMessageTransition);
      break;
    case "board":
      next.board = saved.board;
      next.transport = {
        ...structuredClone(saved.transport),
        pauseMessageTransition: next.transport.pauseMessageTransition
      } as AppConfig["transport"];
      next.updateIntervalMinutes = saved.updateIntervalMinutes;
      break;
    case "haBlock":
    case "layout":
      next.layout = saved.layout === null ? null : structuredClone(saved.layout);
      next.haBlock = structuredClone(saved.haBlock);
      break;
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

/** A resize must travel with its placement so saved geometry never trails the block settings. */
export function updateHABlockDraft(config: AppConfig, haBlock: HABlockConfig): AppConfig {
  const resized = haBlock.width !== config.haBlock.width || haBlock.height !== config.haBlock.height;
  return { ...config, haBlock, layout: resized && config.layout
    ? config.layout.map((entry) => entry.elementId === HA_BLOCK_ELEMENT_ID ? { ...entry, width: haBlock.width } : entry)
    : config.layout };
}
