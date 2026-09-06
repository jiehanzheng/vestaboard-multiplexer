import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

export interface WebActions {
  status(): unknown;
  config(): unknown;
  elements(): unknown;
  save(value: unknown): Promise<unknown>;
  preview(value: unknown): unknown | Promise<unknown>;
  pause(value: unknown): Promise<unknown>;
  login(action: "start" | "cancel" | "check"): Promise<unknown>;
  homeAssistant?(action: "test" | "entities", value: unknown): Promise<unknown>;
}

export async function startWebServer(actions: WebActions, options: {
  port: number; host?: string; assets?: string;
}): Promise<{ broadcast(): void; close(): Promise<void>; port: number }> {
  const clients = new Set<ServerResponse>();
  const assets = resolve(options.assets ?? "dist/web");
  const broadcast = (): void => {
    const event = `data: ${JSON.stringify(actions.status())}\n\n`;
    for (const client of clients) {
      // A slow browser reconnects to the current snapshot instead of building an event backlog.
      if (!client.write(event)) { client.destroy(); clients.delete(client); }
    }
  };
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
        clients.add(response);
        response.write(`data: ${JSON.stringify(actions.status())}\n\n`);
        request.on("close", () => clients.delete(response));
        return;
      }
      if (request.method === "GET" && path === "/api/status") return json(200, actions.status());
      if (request.method === "GET" && path === "/api/config") return json(200, actions.config());
      if (request.method === "GET" && path === "/api/elements") return json(200, actions.elements());
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
        if (path === "/api/config") return json(200, await actions.save(value));
        if (path === "/api/preview") return json(200, await actions.preview(value));
        if (path === "/api/pause") return json(200, await actions.pause(value));
        for (const action of ["start", "cancel", "check"] as const) {
          if (path === `/api/login/${action}`) return json(200, await actions.login(action));
        }
        for (const action of ["test", "entities"] as const) {
          if (path === `/api/ha/${action}` && actions.homeAssistant) return json(200, await actions.homeAssistant(action, value));
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
    for (const client of clients) if (!client.write(": keepalive\n\n")) client.destroy();
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
      for (const client of clients) client.end();
      clients.clear();
      server.closeIdleConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}
