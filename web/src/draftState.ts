import { DEFAULT_HA_BLOCK_CONFIG, haBlockElementId, type HABlockInstance } from "../../src/plugins/haBlock/config.js";
import type { AppConfig, ConfigPatch, ConfigSaveResponse, PublicAppConfig } from "../../src/contracts/config.js";

export type ConfigSection = "codex" | "water" | "haBlock" | "barRows" | "ha" | "pause" | "board" | "layout";

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
      updateLimits: structuredClone(config.updateLimits)
    };
    case "barRows":
    case "haBlock":
    case "layout": return { layout: config.layout === null ? null : structuredClone(config.layout), haBlocks: structuredClone(config.haBlocks), barRows: structuredClone(config.barRows) };
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
      return { board: config.board, transport, updateLimits: structuredClone(config.updateLimits) };
    }
    case "barRows":
    case "haBlock":
    case "layout": return { layout: config.layout, haBlocks: config.haBlocks, barRows: config.barRows };
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
      next.updateLimits = structuredClone(saved.updateLimits);
      break;
    case "barRows":
    case "haBlock":
    case "layout":
      next.layout = saved.layout === null ? null : structuredClone(saved.layout);
      next.haBlocks = structuredClone(saved.haBlocks);
      next.barRows = structuredClone(saved.barRows);
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
export function updateHABlockDraft(config: AppConfig, block: HABlockInstance): AppConfig {
  const previous = config.haBlocks.find((value) => value.id === block.id);
  if (!previous) throw new Error("The block no longer exists.");
  const resized = block.width !== previous.width || block.height !== previous.height;
  return { ...config, haBlocks: config.haBlocks.map((value) => value.id === block.id ? block : value),
    layout: resized && config.layout
      ? config.layout.map((entry) => entry.elementId === haBlockElementId(block.id) ? { ...entry, width: block.width } : entry)
      : config.layout };
}

export function addHABlockDraft(config: AppConfig, id: string): AppConfig {
  let suffix = 1;
  while (config.haBlocks.some((block) => block.name === `HA block ${suffix}`)) suffix++;
  return { ...config, haBlocks: [...config.haBlocks, { ...DEFAULT_HA_BLOCK_CONFIG, id, name: `HA block ${suffix}` }] };
}

export function removeHABlockDraft(config: AppConfig, id: string): AppConfig {
  return { ...config, haBlocks: config.haBlocks.filter((block) => block.id !== id),
    layout: config.layout?.filter((entry) => entry.elementId !== haBlockElementId(id)) ?? null };
}
