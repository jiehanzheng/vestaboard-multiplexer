import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { ConfigPatchSchema, PublicConfigSchema, type ConfigPatch, type PublicConfig } from "./contracts/config.js";
import { ElementsResponseSchema, LoginStatusSchema, PauseRequestSchema, PreviewRequestSchema, PreviewResponseSchema, RuntimeStatusSchema, type ElementsResponse, type LoginStatus, type PauseRequest, type PreviewRequest, type PreviewResponse, type RuntimeStatus } from "./contracts/api.js";
import { HAConnectionTestRequestSchema, HAConnectionTestResponseSchema, HAEntitiesRequestSchema, HAEntitiesResponseSchema, type HAEntitiesRequest, type HAEntitiesResponse, type HAStatus } from "./contracts/homeAssistant.js";
import { LogsResponseSchema, type LogsResponse } from "./logger.js";

export interface WebActions {
  status(): RuntimeStatus;
  config(): PublicConfig;
  elements(): ElementsResponse;
  save(value: ConfigPatch): Promise<PublicConfig>;
  preview(value: PreviewRequest): PreviewResponse | Promise<PreviewResponse>;
  pause(value: PauseRequest): Promise<RuntimeStatus>;
  login(action: "start" | "cancel" | "check"): Promise<LoginStatus>;
  homeAssistant?(action: "test" | "entities", value: HAEntitiesRequest): Promise<HAStatus | HAEntitiesResponse>;
  logs?(): LogsResponse;
  subscribeLogs?(listener: () => void): () => void;
}

interface EventClient {
  response: ServerResponse;
  pending: Set<"runtime" | "logs">;
  writing: boolean;
  closed: boolean;
}

export async function startWebServer(actions: WebActions, options: {
  port: number; host?: string; assets?: string;
}): Promise<{ broadcast(): void; close(): Promise<void>; port: number }> {
  const clients = new Set<EventClient>();
  const assets = resolve(options.assets ?? "dist/public");
  const queue = (client: EventClient, kind: "runtime" | "logs"): void => {
    if (client.closed) return;
    client.pending.add(kind);
    flush(client);
  };
  const flush = (client: EventClient): void => {
    if (client.closed || client.writing) return;
    const kind = client.pending.values().next().value as "runtime" | "logs" | undefined;
    if (!kind) return;
    client.pending.delete(kind);
    const payload = kind === "runtime"
      ? `data: ${JSON.stringify(RuntimeStatusSchema.parse(actions.status()))}\n\n`
      : `event: logs\ndata: ${JSON.stringify(LogsResponseSchema.parse(actions.logs?.() ?? { entries: [] }))}\n\n`;
    client.writing = true;
    if (!client.response.write(payload)) {
      client.response.once("drain", () => { client.writing = false; flush(client); });
    } else {
      client.writing = false;
      flush(client);
    }
  };
  const broadcast = (): void => { for (const client of clients) queue(client, "runtime"); };
  const broadcastLogs = (): void => { for (const client of clients) queue(client, "logs"); };
  const unsubscribeLogs = actions.subscribeLogs?.(broadcastLogs);
  const server = createServer(async (request, response) => {
    const json = (status: number, value: unknown): void => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(value));
    };
    try {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && path === "/api/events") {
        response.writeHead(200, {
          "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
          "Connection": "keep-alive", "X-Accel-Buffering": "no"
        });
        const client: EventClient = { response, pending: new Set(), writing: false, closed: false };
        clients.add(client);
        client.pending.add("runtime");
        client.pending.add("logs");
        flush(client);
        request.on("close", () => { client.closed = true; clients.delete(client); });
        return;
      }
      if (request.method === "GET" && path === "/api/status") return json(200, RuntimeStatusSchema.parse(actions.status()));
      if (request.method === "GET" && path === "/api/logs") return json(200, LogsResponseSchema.parse(actions.logs?.() ?? { entries: [] }));
      if (request.method === "GET" && path === "/api/config") return json(200, PublicConfigSchema.parse(actions.config()));
      if (request.method === "GET" && path === "/api/elements") return json(200, ElementsResponseSchema.parse(actions.elements()));
      if (request.method === "POST" && path.startsWith("/api/")) {
        const origin = request.headers.origin;
        if (origin && new URL(origin).host !== request.headers.host) return json(403, { error: "Cross-origin changes are not allowed." });
        if (!request.headers["content-type"]?.startsWith("application/json")) return json(415, { error: "Expected JSON." });
        let body = "";
        for await (const chunk of request) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 1_048_576) return json(413, { error: "Request is too large." });
        }
        const value: unknown = body ? JSON.parse(body) : {};
        if (path === "/api/config") return json(200, PublicConfigSchema.parse(await actions.save(ConfigPatchSchema.parse(value))));
        if (path === "/api/preview") return json(200, PreviewResponseSchema.parse(await actions.preview(PreviewRequestSchema.parse(value))));
        if (path === "/api/pause") return json(200, RuntimeStatusSchema.parse(await actions.pause(PauseRequestSchema.parse(value))));
        for (const action of ["start", "cancel", "check"] as const) {
          if (path === `/api/login/${action}`) return json(200, LoginStatusSchema.parse(await actions.login(action)));
        }
        for (const action of ["test", "entities"] as const) {
          if (path === `/api/ha/${action}` && actions.homeAssistant) {
            const input = (action === "test" ? HAConnectionTestRequestSchema : HAEntitiesRequestSchema).parse(value);
            const result = await actions.homeAssistant(action, input);
            return json(200, (action === "test" ? HAConnectionTestResponseSchema : HAEntitiesResponseSchema).parse(result));
          }
        }
      }
      if (path.startsWith("/api/")) return json(404, { error: "Unknown endpoint." });
      if (request.method !== "GET") return json(405, { error: "Method not allowed." });
      const file = resolve(assets, `.${decodeURIComponent(path === "/" ? "/index.html" : path)}`);
      if (!file.startsWith(`${assets}${sep}`)) return json(404, { error: "Not found." });
      try {
        const content = await readFile(file);
        const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
        response.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream" });
        response.end(content);
      } catch { json(404, { error: "UI assets are missing. Run pnpm build." }); }
    } catch (error) {
      json(400, { error: error instanceof Error ? error.message : "Request failed." });
    }
  });
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (client.closed || client.writing) continue;
      client.writing = true;
      if (!client.response.write(": keepalive\n\n")) {
        client.response.once("drain", () => { client.writing = false; flush(client); });
      } else {
        client.writing = false;
        flush(client);
      }
    }
  }, 20_000);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host ?? "0.0.0.0", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) { clearInterval(heartbeat); throw error; }
  return {
    broadcast,
    port: (server.address() as { port: number }).port,
    close: async () => {
      clearInterval(heartbeat);
      unsubscribeLogs?.();
      for (const client of clients) { client.closed = true; client.response.end(); }
      clients.clear();
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
