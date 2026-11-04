export type View = "board" | "plugins" | "settings" | "logs";
export type PluginView = "codex" | "haBlock" | "barRows";
export interface RouteState {
  view: View;
  plugin?: PluginView;
  logsSource?: string;
}

export function routeFromHash(hash: string): RouteState {
  const [path, query] = (hash.replace(/^#/, "") || "board").split("?", 2);
  if (path === "logs" || path === "settings/logs") {
    return { view: "logs", logsSource: new URLSearchParams(query ?? "").get("source") || undefined };
  }
  if (path === "plugins/codex") return { view: "plugins", plugin: "codex" };
  if (path === "plugins/barRows") return { view: "plugins", plugin: "barRows" };
  if (path === "plugins/haBlock") return { view: "plugins", plugin: "haBlock" };
  if (path === "plugins") return { view: "plugins" };
  if (path === "settings") return { view: "settings" };
  return { view: "board" };
}

export function routeToHash(route: RouteState): string {
  if (route.view === "plugins") return route.plugin ? `#plugins/${route.plugin}` : "#plugins";
  if (route.view === "logs") return `#logs${route.logsSource ? `?source=${encodeURIComponent(route.logsSource)}` : ""}`;
  return `#${route.view}`;
}
