import { schemaIssueDetails } from "@knowledge-base/api/lib/kb/argument-reasons";
import type { KbToolName } from "@knowledge-base/api/lib/kb/protocol/catalog";
import { buildKbErrorCallToolResult } from "@knowledge-base/api/lib/kb/protocol/envelope";
import { kbReadToolSchemas } from "@knowledge-base/api/lib/kb/protocol/reads";
import { kbWriteToolSchemas } from "@knowledge-base/api/lib/kb/protocol/writes";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { type McpServer, ProtocolError } from "@modelcontextprotocol/server";
import { ZodError } from "zod";
import type { BearerAdmission } from "./context";
import type { Discovery } from "./discovery";
import { dispatchTool, toolFailure } from "./tool-dispatch";

const schemas = { ...kbReadToolSchemas, ...kbWriteToolSchemas };
export function validateToolCall<N extends KbToolName>(name: N, input: unknown) {
  return schemas[name].input.parse(input);
}
export function bindTools(
  server: McpServer,
  actor: BearerAdmission,
  signal: AbortSignal,
  options: {
    pending: Set<Promise<unknown>>;
    runtime(): KbRuntimeConfig;
    masterKey(): Promise<string | undefined> | string | undefined;
    /** This connection's scoped list; present for `tools/list` requests. */
    discovery?: Discovery | null;
    /** The HTTP request id, carried into failure logs. */
    requestId?: string;
  },
) {
  // Discovery is computed before the server is built (the factory owns its
  // live reads and their failures); a list request always carries it.
  server.server.setRequestHandler("tools/list", async () => {
    if (!options.discovery) throw new ProtocolError(-32603, "Discovery unavailable");
    return { tools: options.discovery.tools, ttlMs: 0, cacheScope: "private" as const };
  });
  server.server.setRequestHandler("tools/call", async (request) => {
    if (!Object.hasOwn(schemas, request.params.name))
      throw new ProtocolError(-32602, "Unknown tool");
    const name = request.params.name as KbToolName;
    let input: ReturnType<typeof validateToolCall>;
    try {
      input = validateToolCall(name, request.params.arguments ?? {});
    } catch (error) {
      // Say which argument and why (a closed reason, a safe pointer).
      return buildKbErrorCallToolResult(
        "INVALID_ARGUMENT",
        error instanceof ZodError
          ? schemaIssueDetails(error, request.params.arguments ?? {}, name)
          : {},
      );
    }
    const work = (async () => {
      try {
        return await dispatchTool(name, input, {
          actor,
          signal,
          runtime: options.runtime(),
          masterKey: await options.masterKey(),
          requestId: options.requestId,
        });
      } catch (error) {
        return toolFailure(error, { tool: name, requestId: options.requestId });
      }
    })();
    options.pending.add(work);
    try {
      return await work;
    } finally {
      options.pending.delete(work);
    }
  });
}
