/**
 * The MCP server TrueForge connects to.
 *
 * Registration is mechanical: every tool in TOOLS is registered with the annotations
 * it declares. Nothing here decides what is gated, because that decision belongs in
 * the annotation next to the tool it describes, where it is visible to anyone reading
 * the tool.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { TOOLS, type ToolDeps } from "./tools.js";

export const SERVER_NAME = "contain";
export const SERVER_VERSION = "0.1.0";

export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(args ?? {}, deps);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          // Surfaced to the agent as a tool error rather than thrown, so a refused
          // action becomes something the agent can report instead of a crash.
          return {
            isError: true,
            content: [
              { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
            ],
          };
        }
      },
    );
  }

  return server;
}

/**
 * Serve over Streamable HTTP, which is how TrueForge connects to a remote MCP server.
 *
 * Stateless mode: each request carries its own transport. The run state lives in
 * `deps`, not in the transport, so a reconnect does not lose the investigation.
 */
export async function startHttpServer(deps: ToolDeps, port: number): Promise<HttpServer> {
  const http = createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: SERVER_NAME, tools: TOOLS.length }));
      return;
    }

    void (async () => {
      // The SDK's option and Transport types declare optional members without
      // `| undefined`, which this project's `exactOptionalPropertyTypes` rejects. The
      // casts are confined to this boundary rather than relaxing the setting for our
      // own code, where the strictness is worth keeping.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
      const server = createMcpServer(deps);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport as unknown as Parameters<McpServer["connect"]>[0]);
      await transport.handleRequest(req, res);
    })().catch((error: unknown) => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(error) }));
    });
  });

  await new Promise<void>((resolve) => http.listen(port, resolve));
  return http;
}
