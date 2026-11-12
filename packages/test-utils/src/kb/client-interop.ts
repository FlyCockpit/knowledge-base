/**
 * Official TypeScript MCP SDK server (`@modelcontextprotocol/server`,
 * profile 2026-07-28) hosting a small kb/1 catalog for the Rust `kb-client`
 * interop suite. Same SDK entry and options as `apps/server/src/mcp/handler.ts`
 * (modern-only, JSON responses, no subscriptions); tool payloads come from the
 * canonical protocol fixture corpus so both sides validate the same shapes.
 */
import { once } from "node:events";
import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import { createServer as createHttpsServer, type ServerOptions } from "node:https";
import { KB_TOOL_NAMES } from "@knowledge-base/api/lib/kb/protocol/catalog";
import {
  buildKbErrorCallToolResult,
  buildKbSuccessCallToolResult,
} from "@knowledge-base/api/lib/kb/protocol/envelope";
import fixtures from "@knowledge-base/api/lib/kb/protocol/fixtures.json" with { type: "json" };
import protocol from "@knowledge-base/api/lib/kb/protocol/schema.json" with { type: "json" };
import {
  createMcpHandler,
  McpServer,
  ProtocolError,
  type Tool,
} from "@modelcontextprotocol/server";

type InteropRequest = {
  headers: Record<string, string | undefined>;
  body: {
    jsonrpc?: unknown;
    id?: unknown;
    method?: unknown;
    params?: { name?: unknown; arguments?: Record<string, unknown>; _meta?: unknown };
  };
};

export type ClientInteropFixture = {
  /** Loopback MCP resource, `http://127.0.0.1:<port>/mcp`. */
  resource: string;
  token: string;
  requests: InteropRequest[];
  /** Tool names whose in-flight call observed the client hanging up. */
  aborted: string[];
  /** Idempotency keys seen on `knowledge_documents_create`, in order. */
  mutationKeys: string[];
  /** Committed unique operation keys; a dropped reply does not undo an effect. */
  readonly mutationEffects: number;
  /** Every `knowledge_changes_apply` argument object, in order. */
  dreamApplies: Record<string, unknown>[];
  close(): Promise<void>;
};

const TOOLS = [
  "knowledge_bases_list",
  "knowledge_bases_get",
  "knowledge_documents_get",
  "knowledge_documents_create",
  "knowledge_index_status",
  "knowledge_changes_apply",
] as const;
/** `knowledge_bases_get` answers for this KB (dream base pinning). */
const INTEROP_DREAM_KB = "dreamkbdreamkbdreamkbdre";
const DREAM_COMMIT = "3".repeat(40);
type InteropTool = (typeof TOOLS)[number];
const catalog = fixtures.tools as Record<InteropTool, { validOutput: unknown }>;

function header(req: IncomingMessage, name: string) {
  const value = req.headers[name];
  return Array.isArray(value) ? value.join(",") : value;
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function startClientInteropFixture(
  token: string,
  options: { fullCatalog?: boolean; tls?: ServerOptions } = {},
): Promise<ClientInteropFixture> {
  const requests: InteropRequest[] = [];
  const aborted: string[] = [];
  const mutationKeys: string[] = [];
  const dreamApplies: Record<string, unknown>[] = [];
  const effects = new Set<string>();
  let droppedReply = false;
  // The full catalog is listed in catalog order, as the server does; the
  // CLI bridge accepts only catalog-ordered lists.
  const names: readonly (keyof typeof protocol.tools)[] = options.fullCatalog
    ? KB_TOOL_NAMES
    : TOOLS;

  const handler = createMcpHandler(
    (ctx) => {
      const signal = ctx.requestInfo?.signal;
      const server = new McpServer(
        { name: "kb-client-interop", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );
      server.server.setRequestHandler("tools/list", async () => ({
        tools: names.map((name) => ({
          name,
          inputSchema: protocol.tools[name].input as Tool["inputSchema"],
          ...(options.fullCatalog
            ? {
                outputSchema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["schemaVersion", "data"],
                  properties: {
                    schemaVersion: { const: "kb/1" },
                    data: protocol.tools[name].output,
                  },
                },
              }
            : {}),
        })),
      }));
      server.server.setRequestHandler("tools/call", async (request) => {
        const name = request.params.name as InteropTool;
        if (!names.includes(name)) throw new ProtocolError(-32602, "Unknown tool");
        if (options.fullCatalog && name !== "knowledge_index_status") {
          if (
            request.params.name === "knowledge_sealed_resolve" &&
            request.params.arguments?.path === "missing.md"
          )
            return buildKbErrorCallToolResult("UNRESOLVED_REFERENCE");
          if (
            name === "knowledge_documents_create" &&
            request.params.arguments?.idempotencyKey === "remote-lost-reply-0001"
          ) {
            const key = String(request.params.arguments.idempotencyKey);
            mutationKeys.push(key);
            effects.add(key);
          }
          return buildKbSuccessCallToolResult(
            fixtures.tools[name as keyof typeof fixtures.tools].validOutput,
          );
        }
        switch (name) {
          case "knowledge_bases_get": {
            if (request.params.arguments?.kbId !== INTEROP_DREAM_KB)
              return buildKbErrorCallToolResult("NOT_FOUND");
            const answer = catalog[name].validOutput as { kb: Record<string, unknown> };
            return buildKbSuccessCallToolResult({
              ...answer,
              kb: { ...answer.kb, id: INTEROP_DREAM_KB },
            });
          }
          case "knowledge_changes_apply": {
            const args = request.params.arguments ?? {};
            dreamApplies.push(args);
            const dream = args.dream as { upserts?: { id: string }[] } | undefined;
            return buildKbSuccessCallToolResult({
              operationId: "00000000-0000-4000-8000-0000000000ee",
              kind: "applied",
              commitSha: DREAM_COMMIT,
              baseRevision: args.baseRevision,
              proposal: null,
              changedPaths: (dream?.upserts ?? []).map((u) => `concepts/${u.id}.md`),
              sourceSessionIds: args.sourceSessionIds,
              indexJobId: "00000000-0000-4000-8000-0000000000ff",
            });
          }
          case "knowledge_documents_create": {
            mutationKeys.push(String(request.params.arguments?.idempotencyKey));
            // First attempt fails retryably; the client must resend the same key.
            if (mutationKeys.length === 1) return buildKbErrorCallToolResult("STORAGE_UNAVAILABLE");
            return buildKbSuccessCallToolResult(catalog[name].validOutput);
          }
          case "knowledge_index_status":
            // Held until the client hangs up; the abort is the observable effect.
            await new Promise<void>((resolve) => {
              if (!signal || signal.aborted) return resolve();
              signal.addEventListener("abort", () => resolve(), { once: true });
            });
            aborted.push(name);
            return buildKbErrorCallToolResult("CANCELLED");
          default:
            return buildKbSuccessCallToolResult(catalog[name].validOutput);
        }
      });
      return server;
    },
    { legacy: "reject", responseMode: "json", maxSubscriptions: 0 },
  );

  const listener: RequestListener = (req, res) => {
    void (async () => {
      const abort = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) abort.abort();
      });
      const bytes = await readBody(req);
      let body: InteropRequest["body"] = {};
      try {
        body = JSON.parse(bytes.toString("utf8")) as InteropRequest["body"];
      } catch {
        // Recorded as an empty body; the SDK answers the parse error.
      }
      requests.push({
        headers: Object.fromEntries(Object.keys(req.headers).map((k) => [k, header(req, k)])),
        body,
      });
      if (header(req, "authorization") !== `Bearer ${token}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "UNAUTHORIZED" }));
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
      }
      const response = await handler.fetch(
        new Request(`http://127.0.0.1${req.url ?? "/"}`, {
          method: req.method,
          headers,
          body: bytes,
          signal: abort.signal,
        }),
      );
      const out = Buffer.from(await response.arrayBuffer());
      if (res.destroyed) return;
      if (
        options.fullCatalog &&
        !droppedReply &&
        body.params?.name === "knowledge_documents_create" &&
        body.params.arguments?.idempotencyKey === "remote-lost-reply-0001"
      ) {
        droppedReply = true;
        res.destroy(); // The SDK has committed/captured the effect before the lost reply.
        return;
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(out);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };
  const http: Server = options.tls
    ? createHttpsServer(options.tls, listener)
    : createServer(listener);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("interop fixture has no port");
  return {
    resource: `${options.tls ? "https" : "http"}://127.0.0.1:${address.port}/mcp`,
    token,
    requests,
    aborted,
    mutationKeys,
    get mutationEffects() {
      return effects.size;
    },
    dreamApplies,
    async close() {
      await handler.close();
      http.closeAllConnections();
      http.close();
      await once(http, "close");
    },
  };
}
