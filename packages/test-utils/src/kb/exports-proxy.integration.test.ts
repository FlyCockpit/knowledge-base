/// <reference path="./pg.d.ts" />
/**
 * Scaled-down Cloudflare Tunnel budget: an HTTP front answers 524 to any
 * single request that runs longer than BUDGET_MS (Cloudflare's is 100 s),
 * and the asset store is deliberately slow, so one export build takes several
 * budgets. Driven over real MCP + PostgreSQL/Git/CAS: start, status polling,
 * framed download and acknowledgement each fit the budget and the export
 * succeeds; the same build awaited inside one request (the removed
 * synchronous shape) is cut off with 524.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { credentialQuery } from "@knowledge-base/api/lib/kb/credential-query";
import {
  awaitExportBuild,
  type ExportActor,
  exportStatus,
  prepareExport,
} from "@knowledge-base/api/lib/kb/exports";
import type { CredentialVerifier, TokenPrincipal } from "@knowledge-base/api/lib/kb/principal";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { mintPersonalToken } from "@knowledge-base/api/lib/mcp-token-access";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import { describe, expect, it } from "vitest";
import {
  asset,
  commit,
  fixture,
  gatedStore,
  pause,
  registerExportHooks,
  released,
  runtime,
} from "./export-fixture";

type Actor = { principal: TokenPrincipal; verifier: CredentialVerifier; recheck(): Promise<void> };
type Gate = {
  closed: boolean;
  outstanding: number;
  close(): Promise<void>;
  admit(signal: AbortSignal): { signal: AbortSignal; release(): void } | null;
};
const { createAdmissionGate } = (await import(
  new URL("../../../../apps/server/src/mcp/admission.ts", import.meta.url).href
)) as { createAdmissionGate(): Gate };
const { createBearerAdmission } = (await import(
  new URL("../../../../apps/server/src/mcp/auth.ts", import.meta.url).href
)) as {
  createBearerAdmission(options: {
    origin: string;
    withQuery: ReturnType<typeof credentialQuery>;
    gate: Gate;
  }): (request: Request) => Promise<Actor>;
};
const { createMcpEndpoint } = (await import(
  new URL("../../../../apps/server/src/mcp/handler.ts", import.meta.url).href
)) as {
  createMcpEndpoint(options: {
    origin: string;
    admit(request: Request): Promise<Actor>;
    gate: Gate;
    runtime(): KbRuntimeConfig;
    masterKey(): undefined;
  }): { fetch(request: Request): Promise<Response>; close(): Promise<void> };
};

registerExportHooks();

/** Scaled down from Cloudflare's 100 s per-request limit. */
const BUDGET_MS = 3000;
/** Every source frame waits this long: the build takes several budgets. */
const FRAME_DELAY_MS = 800;

describe("export through a proxy with a per-request budget and slow storage", () => {
  it("start + status polling + framed download succeed where one long request would 524", async () => {
    const base = await fixture();
    const entry = await asset(base);
    // Four 400 kB assets: 12 delayed frames, about 10 s of build.
    await commit(
      base,
      Array.from({ length: 4 }, (_, i) => ({ ...entry, path: `media/${i}.wav` })),
    );
    const slow: KbRuntimeConfig = {
      ...runtime,
      blobStore: gatedStore(runtime.blobStore, (signal) => pause(FRAME_DELAY_MS, signal)),
    };
    const gate = createAdmissionGate();
    let origin = "";
    let endpoint: ReturnType<typeof createMcpEndpoint> | undefined;
    const durations: { path: string; ms: number; status: number }[] = [];
    let syncActor: ExportActor | undefined;
    // The budget front: whatever runs past BUDGET_MS is answered 524, as the tunnel does.
    const proxy = createServer(
      getRequestListener(async (incoming) => {
        const started = Date.now();
        const path = new URL(incoming.url).pathname;
        const work =
          path === "/sync-prepare"
            ? (async () => {
                // The removed synchronous shape: one request owns the whole build.
                const job = await prepareExport(slow, syncActor!, {
                  kbId: base.kbId,
                  kind: "assets",
                  idempotencyKey: randomUUID(),
                });
                await awaitExportBuild(job.transferId);
                return Response.json(
                  await exportStatus(slow, syncActor!, {
                    kbId: base.kbId,
                    transferId: job.transferId,
                  }),
                );
              })()
            : endpoint!.fetch(incoming);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const budget = new Promise<Response>((done) => {
          timer = setTimeout(
            () => done(new Response("origin timeout", { status: 524 })),
            BUDGET_MS,
          );
        });
        const response = await Promise.race([work, budget]);
        clearTimeout(timer);
        void work.catch(() => undefined);
        durations.push({ path, ms: Date.now() - started, status: response.status });
        return response;
      }),
    );
    await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing proxy port");
    origin = `http://127.0.0.1:${address.port}`;
    const configured = { ...slow, canonicalOrigin: origin };
    const admit = createBearerAdmission({
      origin,
      gate,
      withQuery: credentialQuery(runtime.connectionString),
    });
    endpoint = createMcpEndpoint({
      origin,
      gate,
      runtime: () => configured,
      masterKey: () => undefined,
      admit,
    });
    try {
      const minted = await mintPersonalToken(configured, base.actor.principal.userId, {
        name: "proxy export",
        scopes: ["mcp:read"],
        toolGroups: [...MCP_TOOL_GROUPS],
        acl: [{ kbId: base.kbId, bits: ["read"] }],
        expiresAt: null,
      });
      const call = async <T>(name: string, input: unknown): Promise<T> => {
        const response = await fetch(`${origin}/mcp`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${minted.secret}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-method": "tools/call",
            "mcp-protocol-version": "2026-07-28",
            "mcp-name": name,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name,
              arguments: input,
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": { name: "proxy-test", version: "1" },
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        });
        expect(response.status, name).toBe(200);
        const wire = (await response.json()) as {
          result: { isError: boolean; structuredContent: { data: T } };
        };
        expect(wire.result.isError, `${name}: ${JSON.stringify(wire.result)}`).toBe(false);
        return wire.result.structuredContent.data;
      };
      type Job = { transferId: string; state: string; size: number | null; contentHash: string };
      const begun = Date.now();
      const job = await call<Job>("knowledge_export_prepare", {
        kbId: base.kbId,
        kind: "assets",
        idempotencyKey: randomUUID(),
      });
      expect(["pending", "building"]).toContain(job.state);
      let status = job;
      while (status.state === "pending" || status.state === "building") {
        await new Promise((done) => setTimeout(done, 250));
        status = await call<Job>("knowledge_export_status", {
          kbId: base.kbId,
          transferId: job.transferId,
        });
      }
      const buildMs = Date.now() - begun;
      expect(status.state).toBe("ready");
      // The build alone is several budgets long ...
      expect(buildMs).toBeGreaterThan(2 * BUDGET_MS);
      const hash = createHash("sha256");
      let offset = 0;
      for (;;) {
        const frame = await call<{ bytesBase64: string; nextOffset: number; eof: boolean }>(
          "knowledge_transfer_read",
          { kbId: base.kbId, transferId: job.transferId, offset },
        );
        hash.update(Buffer.from(frame.bytesBase64, "base64"));
        offset = frame.nextOffset;
        if (frame.eof) break;
      }
      expect(offset).toBe(status.size);
      expect(`sha256:${hash.digest("hex")}`).toBe(status.contentHash);
      await call("knowledge_export_complete", { kbId: base.kbId, transferId: job.transferId });
      await released(job.transferId, "DOWNLOADED");
      // ... yet every request fit the budget: none was cut off.
      expect(durations.length).toBeGreaterThan(3);
      expect(durations.filter((d) => d.status === 524)).toEqual([]);
      expect(Math.max(...durations.map((d) => d.ms))).toBeLessThan(BUDGET_MS);

      // The same build held inside one request is cut off by the budget.
      syncActor = { principal: base.actor.principal };
      const sync = await fetch(`${origin}/sync-prepare`);
      expect(sync.status).toBe(524);
      expect(durations.at(-1)).toMatchObject({ path: "/sync-prepare", status: 524 });
    } finally {
      await endpoint.close();
      proxy.closeAllConnections();
      await new Promise<void>((done, fail) =>
        proxy.close((error) => (error ? fail(error) : done())),
      );
    }
  }, 120_000);
});
