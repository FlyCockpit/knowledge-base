/// <reference path="./pg.d.ts" />
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { getRequestListener } from "@hono/node-server";
import { credentialQuery } from "@knowledge-base/api/lib/kb/credential-query";
import { reclaimExports } from "@knowledge-base/api/lib/kb/exports";
import type { CredentialVerifier, TokenPrincipal } from "@knowledge-base/api/lib/kb/principal";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { mintPersonalToken, revokePersonalToken } from "@knowledge-base/api/lib/mcp-token-access";
import { MCP_TOOL_GROUPS } from "@knowledge-base/auth/mcp-tool-groups";
import { beforeEach, describe, expect, it } from "vitest";
import { requireBuiltArtifact } from "./build-artifacts.mjs";
import {
  artifactPath,
  asset,
  commit,
  fixture,
  prisma,
  registerExportHooks,
  released,
  runtime,
  s3Sources,
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
const run = promisify(execFile);
const cliDir = resolve(import.meta.dirname, "../../../../apps/cli");
const targetDir = join(cliDir, "target");
const binary = requireBuiltArtifact(
  join(targetDir, "debug/kb"),
  "pnpm test:kb --build-only exports",
);
// The registered runner builds this exact binary as a prerequisite, outside
// the unchanged 30-second behavioral test deadline.
registerExportHooks();

describe.each([
  "empty",
  "whole",
  "s3",
  "lost-eof",
  "lost-ack",
  "failed-ack",
  "revoked",
  "save-race",
] as const)("Rust CLI export over mounted MCP and real PostgreSQL/Git/CAS: %s", (mode) => {
  let base: Awaited<ReturnType<typeof fixture>>;
  let entries: Awaited<ReturnType<typeof asset>>[];
  beforeEach(async () => {
    base = await fixture();
    entries = mode === "empty" ? [] : [await asset(base)];
    if (mode !== "empty") await commit(base, entries);
  });
  it("verified durable save precedes same-PAT acknowledgement", async () => {
    const local = mkdtempSync(join(tmpdir(), "kb-cli-export-"));
    const output = join(local, "export.zip");
    const destination = mode === "empty" ? "export.zip" : output;
    const gate = createAdmissionGate();
    let endpoint: ReturnType<typeof createMcpEndpoint>;
    let transferId = "";
    let prepareInput: unknown;
    let preparedSecret = "";
    let mintedId = "";
    let lost = false;
    let completed = 0;
    let artifactBytes: Buffer | undefined;
    const reads: unknown[] = [];
    const server = createServer(
      getRequestListener(async (request) => {
        const body = (await request.clone().json()) as {
          params: { name: string; arguments: unknown };
        };
        expect(request.headers.get("authorization")).toBe(`Bearer ${preparedSecret}`);
        const name = body.params.name;
        if (name === "knowledge_export_prepare") prepareInput = body.params.arguments;
        if (name === "knowledge_transfer_read") reads.push(body.params.arguments);
        if (name === "knowledge_export_complete") {
          completed++;
          // Observe the real CLI destination at the server boundary, before ack.
          expect(readFileSync(output)).toEqual(artifactBytes);
          if (mode === "failed-ack") return new Response("lost acknowledgement", { status: 503 });
        }
        const response = await endpoint.fetch(request);
        const wire = (await response.clone().json()) as {
          result?: { structuredContent?: { data?: { transferId?: string; eof?: boolean } } };
        };
        const data = wire.result?.structuredContent?.data;
        if (name === "knowledge_export_prepare" && data?.transferId) {
          transferId = data.transferId;
          artifactBytes = readFileSync(artifactPath(transferId));
          if (mode === "revoked")
            await revokePersonalToken(configured, base.actor.principal.userId, mintedId);
        }
        if (mode === "lost-eof" && data?.eof && !lost) {
          lost = true;
          // Real EOF/grace committed, but close the socket before its reply.
          server.closeAllConnections();
        }
        if (mode === "lost-ack" && name === "knowledge_export_complete" && !lost) {
          lost = true;
          // Terminal commit/unlink won, but its reply was lost. The same
          // credential's repeated acknowledgement must be idempotent.
          server.closeAllConnections();
        }
        if (mode === "save-race" && data?.eof) {
          writeFileSync(output, "existing destination", { flag: "wx" });
        }
        return response;
      }),
    );
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing CLI fixture port");
    const origin = `http://127.0.0.1:${address.port}`;
    const remote = mode === "s3" ? await s3Sources(entries) : undefined;
    const configured = { ...(remote?.runtime ?? runtime), canonicalOrigin: origin };
    endpoint = createMcpEndpoint({
      origin,
      gate,
      runtime: () => configured,
      // Export has no master-key dependency; do not load machine env through
      // the mounted endpoint's unrelated sealed-tool default.
      masterKey: () => undefined,
      admit: createBearerAdmission({
        origin,
        gate,
        withQuery: credentialQuery(runtime.connectionString),
      }),
    });
    const env = {
      ...process.env,
      KB_CONFIG_DIR: join(local, "config"),
      KB_DATA_DIR: join(local, "data"),
    };
    try {
      const minted = await mintPersonalToken(configured, base.actor.principal.userId, {
        name: "CLI export",
        scopes: ["mcp:read"],
        toolGroups: [...MCP_TOOL_GROUPS],
        acl: [{ kbId: base.kbId, bits: ["read"] }],
        expiresAt: null,
      });
      preparedSecret = minted.secret;
      mintedId = minted.token.id;
      const tokenFile = join(local, "token");
      writeFileSync(tokenFile, minted.secret, { mode: 0o600 });
      const args = ["--server", origin, "--allow-loopback-http"];
      await run(binary, ["login", ...args, "--token-file", tokenFile], { env });
      const action = run(
        binary,
        [
          "export",
          ...args,
          "--kb",
          base.kbId,
          "--kind",
          mode === "empty" ? "assets" : "whole",
          "--output",
          destination,
          "--idempotency-key",
          randomUUID(),
          "--json",
        ],
        { env, cwd: local, timeout: 25000 },
      );
      if (mode === "revoked" || mode === "save-race") {
        await expect(action).rejects.toMatchObject({ code: 1 });
        if (mode === "revoked") expect(existsSync(output)).toBe(false);
        else expect(readFileSync(output, "utf8")).toBe("existing destination");
        expect(completed).toBe(0);
        const row = await prisma.exportArtifact.findUniqueOrThrow({ where: { id: transferId } });
        expect(row.state).toBe("READY");
        if (mode === "revoked") expect(row.downloadCompletedAt).toBeNull();
        else expect(row.downloadCompletedAt).not.toBeNull();
        return;
      }
      const result = await action;
      expect(`${result.stdout}${result.stderr}`).not.toContain(minted.secret);
      const saved = JSON.parse(result.stdout) as {
        path: string;
        acknowledged: boolean;
        descriptor: { transferId: string; size: number };
      };
      expect(saved.path).toBe(destination);
      expect(saved.descriptor.transferId).toBe(transferId);
      expect(readFileSync(output).length).toBe(saved.descriptor.size);
      expect(saved.acknowledged).toBe(mode !== "failed-ack");
      if (mode === "lost-eof") {
        expect(lost).toBe(true);
        expect(reads.at(-1)).toEqual(reads.at(-2));
      }
      if (mode === "failed-ack") {
        expect(completed).toBe(2);
        expect(result.stderr).toContain("server grace cleanup");
        const graced = await prisma.exportArtifact.findUniqueOrThrow({
          where: { id: transferId },
        });
        expect(graced).toMatchObject({ state: "READY", reclaimedAt: null });
        expect(graced.downloadCompletedAt).not.toBeNull();
        expect(existsSync(artifactPath(transferId))).toBe(true);
        // A sibling credential of the SAME owner cannot consume or complete
        // this artifact. Use the mounted endpoint, preserving real admission.
        const sibling = await mintPersonalToken(configured, base.actor.principal.userId, {
          name: "foreign prepare identity",
          scopes: ["mcp:read"],
          toolGroups: [...MCP_TOOL_GROUPS],
          acl: [{ kbId: base.kbId, bits: ["read"] }],
          expiresAt: null,
        });
        const call = async (secret: string, name: string, input: unknown) =>
          endpoint.fetch(
            new Request(`${origin}/mcp`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${secret}`,
                "content-type": "application/json",
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
                    "io.modelcontextprotocol/clientInfo": { name: "export-test", version: "1" },
                    "io.modelcontextprotocol/clientCapabilities": {},
                  },
                },
              }),
            }),
          );
        for (const [name, input] of [
          ["knowledge_transfer_read", { kbId: base.kbId, transferId, offset: 0 }],
          ["knowledge_export_complete", { kbId: base.kbId, transferId }],
        ] as const) {
          const denied = await call(sibling.secret, name, input);
          const wire = (await denied.json()) as {
            result: { structuredContent: { error: { code: string } } };
          };
          expect(wire.result.structuredContent.error.code).toBe("NOT_FOUND");
        }
        await revokePersonalToken(configured, base.actor.principal.userId, mintedId);
        for (const [name, input] of [
          ["knowledge_export_prepare", prepareInput],
          ["knowledge_transfer_read", { kbId: base.kbId, transferId, offset: 0 }],
          ["knowledge_export_complete", { kbId: base.kbId, transferId }],
        ] as const)
          expect((await call(minted.secret, name, input)).status).toBe(401);
        await reclaimExports(runtime, { now: new Date(graced.expiresAt.getTime() + 1) });
        await released(transferId, "DOWNLOADED");
      } else {
        expect(completed).toBe(mode === "lost-ack" ? 2 : 1);
        await released(transferId, "DOWNLOADED");
      }
      if (remote) {
        expect(
          await prisma.assetCacheEntry.count({ where: { cacheId: remote.binding.cacheId } }),
        ).toBe(0);
        expect(remote.http.requests.map((r) => r.method)).toEqual(["GET"]);
      }
      // A repeated CLI command refuses to replace a saved destination.
      const bytes = readFileSync(output);
      await expect(
        run(binary, ["export", ...args, "--kb", base.kbId, "--output", output], { env }),
      ).rejects.toMatchObject({ code: 1 });
      expect(readFileSync(output)).toEqual(bytes);
    } finally {
      await remote?.close();
      await endpoint.close();
      server.closeAllConnections();
      await new Promise<void>((done, fail) =>
        server.close((error) => (error ? fail(error) : done())),
      );
      rmSync(local, { recursive: true, force: true });
    }
  });
});
