import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { KbAdmissionError } from "@knowledge-base/api/lib/kb/principal";
import { getKbRuntime, type KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { logInternalError } from "@knowledge-base/env/log";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import pkg from "../../package.json" with { type: "json" };
import { createAdmissionGate } from "./admission";
import type { BearerAdmission, BearerAdmitter } from "./context";
import { type Discovery, decideDiscovery, loadDiscoveryInputs } from "./discovery";
import { admissionErrorResponse } from "./errors";
import { bindTools } from "./tools";

const REQUEST_BYTES = 1024 * 1024;
function isAdmissionDenial(error: unknown): boolean {
  return (
    error instanceof KbAdmissionError &&
    (error.code === "UNAUTHORIZED" || error.code === "FORBIDDEN")
  );
}
const RESPONSE_BYTES = 8 * 1024 * 1024;
class LimitError extends Error {}

/** Count actual bytes, including chunked requests, and cancel on disconnect/deadline. */
async function boundedBytes(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        void reader.cancel().catch(() => {});
        throw new LimitError();
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function createMcpEndpoint(options: {
  admit: BearerAdmitter;
  gate: ReturnType<typeof createAdmissionGate>;
  origin: string;
  runtime?: () => KbRuntimeConfig;
  masterKey?: () => string | undefined;
  /**
   * The discovery publication boundary: read the live inputs and run `build`
   * (which produces the complete response) as one decision. Tests inject a
   * fixture; production uses one authority-locked transaction.
   */
  discover?: <T>(
    actor: BearerAdmission,
    publish: (discovery: Discovery) => Promise<T>,
  ) => Promise<T>;
  /** Test seam: runs inside the discovery transaction before each final recheck. */
  beforeDiscoveryDecision?: () => Promise<void>;
}) {
  const runtime = options.runtime ?? getKbRuntime;
  // Every grant, ACL, share and KB-state change commits under the authority
  // lock. Holding it on one transaction for the admission recheck (inherited by
  // the verifier from the operation lease), the live mapping and the response
  // build makes them one decision: nothing read earlier is delivered.
  // Temporary access can still expire inside that transaction (locks cannot
  // stop time); `decideDiscovery` delivers only a response whose elevations
  // are all still in force at its final recheck.
  const discover =
    options.discover ??
    (<T>(actor: BearerAdmission, publish: (discovery: Discovery) => Promise<T>) =>
      runtime().coordinator.run({
        opId: randomUUID(),
        kind: "authority",
        run: ({ lease }) =>
          lease.transaction((query) =>
            decideDiscovery({
              load: (baseOnly) => loadDiscoveryInputs(query, actor, { baseOnly }),
              publish,
              recheck: () => actor.recheck(),
              beforeDecision: options.beforeDiscoveryDecision,
            }),
          ),
      }));
  const admissions = new AsyncLocalStorage<{
    actor: BearerAdmission;
    pending: Set<Promise<unknown>>;
    discovery: Discovery | null;
    requestId?: string;
  }>();
  const transport = createMcpHandler(
    (ctx) => {
      if (options.gate.closed || ctx.requestInfo?.signal.aborted)
        throw new Error("Admission closed");
      const state = admissions.getStore();
      if (!state || !ctx.requestInfo) throw new Error("Missing admitted request");
      const { discovery, requestId } = state;
      const server = new McpServer(
        { name: "knowledge-base", version: pkg.version },
        {
          capabilities: { tools: {} },
          ...(discovery?.instructions ? { instructions: discovery.instructions } : {}),
          // Both results depend on the credential: never shared, never reused.
          cacheHints: {
            "server/discover": { ttlMs: 0, cacheScope: "private" },
            "tools/list": { ttlMs: 0, cacheScope: "private" },
          },
        },
      );
      bindTools(server, state.actor, ctx.requestInfo.signal, {
        pending: state.pending,
        discovery,
        requestId,
        runtime,
        masterKey:
          options.masterKey ??
          (async () => (await import("@knowledge-base/env/shared")).env.KB_MASTER_KEY?.reveal()),
      });
      return server;
    },
    {
      legacy: "reject",
      responseMode: "json",
      maxSubscriptions: 0,
      onerror: (error: unknown) => logInternalError("mcp.endpoint", error),
    },
  );
  return {
    close: transport.close,
    /** `requestId` is the server's log correlation id for this HTTP request. */
    async fetch(request: Request, requestId?: string): Promise<Response> {
      if (request.method !== "POST")
        return new Response(null, { status: 405, headers: { allow: "POST" } });
      const permit = options.gate.admit(request.signal);
      if (!permit) return admissionErrorResponse(new Error(), options.origin);
      const pending = new Set<Promise<unknown>>();
      try {
        const origin = request.headers.get("origin");
        if (origin !== null && origin !== options.origin)
          throw new KbAdmissionError("FORBIDDEN", "Forbidden");
        if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers.get("content-type") ?? ""))
          return new Response(null, { status: 415 });
        let bytes: Uint8Array;
        try {
          bytes = await boundedBytes(request.body, REQUEST_BYTES, permit.signal);
        } catch (error) {
          if (error instanceof LimitError) return new Response(null, { status: 413 });
          throw error;
        }
        const headers = new Headers(request.headers);
        headers.delete("cookie");
        headers.delete("content-length");
        // A request body is consumed once; discovery may publish more than once.
        const canonicalRequest = () =>
          new Request(new URL("/mcp", options.origin), {
            method: "POST",
            headers,
            body: bytes,
            signal: permit.signal,
          });
        const canonical = canonicalRequest();
        const actor = await options.admit(canonical);
        permit.signal.throwIfAborted();
        const deliver = async (discovery: Discovery | null) => {
          const response = await admissions.run({ actor, pending, discovery, requestId }, () =>
            transport.fetch(canonicalRequest()),
          );
          return {
            response,
            body: await boundedBytes(response.body, RESPONSE_BYTES, permit.signal),
          };
        };
        // Only discovery requests pay for the live KB mapping. Its inputs, the
        // admission recheck they start with and the finished response are one
        // boundary decision; a failure (a lost admission included) is this
        // endpoint's error response. The SDK rejects a header that does not
        // match the body, so a mislabelled request gets no list.
        const method = canonical.headers.get("mcp-method");
        const discovering = method === "server/discover" || method === "tools/list";
        const { response, body } = discovering
          ? await discover(actor, deliver)
          : await deliver(null);
        if (!discovering) await actor.recheck();
        permit.signal.throwIfAborted();
        const responseHeaders = new Headers(response.headers);
        responseHeaders.delete("set-cookie");
        responseHeaders.delete("mcp-session-id");
        // Every result depends on the credential (the tool list most of all).
        responseHeaders.set("cache-control", "private, no-store");
        responseHeaders.set("content-length", String(body.byteLength));
        return new Response(body.byteLength ? body : null, {
          status: response.status,
          headers: responseHeaders,
        });
      } catch (error) {
        // A denial (401/403) is the answer; any other code, including an
        // admission STORAGE_UNAVAILABLE, is a server failure the client sees
        // only as 503, so the operator log gets it (R3-W3).
        if (!isAdmissionDenial(error) && !permit.signal.aborted)
          logInternalError("mcp.endpoint", error, { requestId });
        return admissionErrorResponse(error, options.origin);
      } finally {
        // SDK cancellation can finish delivery before a reserved domain operation settles.
        await Promise.allSettled(pending);
        permit.release();
      }
    },
  };
}
