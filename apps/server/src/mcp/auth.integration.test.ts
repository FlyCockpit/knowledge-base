import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { generateApiKeySecret } from "@knowledge-base/api/lib/api-keys";
import type { LockQuery } from "@knowledge-base/api/lib/kb/lock";
import { kbRecoveryGateOpen, setKbRecoveryComplete } from "@knowledge-base/api/lib/kb/recovery";
import type { KbRuntimeConfig } from "@knowledge-base/api/lib/kb/runtime";
import { digestPatSecret, generatePatSecret } from "@knowledge-base/api/lib/mcp-token-access";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmissionGate } from "./admission";
import { createBearerAdmission } from "./auth";
import { buildDiscovery } from "./discovery";
import { createMcpEndpoint } from "./handler";

async function fixture(mode: "keys" | "failure" | "stall" = "keys") {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = ec.publicKey.export({ format: "jwk" });
  const jkt = createHash("sha256")
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
    .digest("base64url");
  let entered!: () => void;
  const requested = new Promise<void>((r) => {
    entered = r;
  });
  // Keys come from the in-process Better Auth store (no HTTP hop to the public
  // origin); the loader stands in for auth.api.getJwks.
  const keys = () => ({
    keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256" }],
  });
  const stalled: Array<(value: unknown) => void> = [];
  const loadJwks = () => {
    entered();
    if (mode === "stall") return new Promise<unknown>((r) => stalled.push(r));
    if (mode === "failure") return Promise.reject(new Error("private upstream failure"));
    return Promise.resolve(keys());
  };
  const origin = "http://kb-fixture.invalid";
  const grantId = randomUUID();
  let queries = 0;
  // DPoP proofs reserve the durable Verification primary key; emulate its uniqueness.
  const reserved = new Set<unknown>();
  const query: LockQuery = async <R>(sql: string, values: unknown[] = []) => ({
    rows: (sql.includes('INSERT INTO "verification"')
      ? reserved.has(values[0])
        ? []
        : [{ id: reserved.add(values[0]) && values[0] }]
      : sql.includes('FROM "grant_kb_acl"')
        ? [{ bits: ["read"] }]
        : sql.includes('FROM "mcp_grant"')
          ? [
              {
                id: grantId,
                kind: "OAUTH",
                userId: "owner",
                clientId: "client",
                scopes: ["mcp:read"],
                toolGroups: ["read", "export"],
                revokedAt: null,
              },
            ]
          : sql.includes('FROM "user"')
            ? [{ banned: false, twoFactorEnabled: true }]
            : []) as R[],
    rowCount: ++queries,
  });
  // Production shape: the bearer admitter and the MCP endpoint share one gate.
  const gate = createAdmissionGate();
  const admit = createBearerAdmission({
    origin,
    query,
    loadJwks,
    gate,
    isClosing: () => gate.closed,
  });
  const jwt = (bound = true, patch: object = {}) => {
    const message = [
      { alg: "RS256", kid: "fixture", typ: "JWT" },
      {
        iss: `${origin}/api/auth`,
        aud: `${origin}/mcp`,
        sub: "owner",
        client_id: "client",
        mcp_grant_id: grantId,
        scope: "mcp:read",
        exp: Math.floor(Date.now() / 1000) + 600,
        ...(bound ? { cnf: { jkt } } : {}),
        ...patch,
      },
    ]
      .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
      .join(".");
    return `${message}.${sign("RSA-SHA256", Buffer.from(message), rsa.privateKey).toString("base64url")}`;
  };
  const proof = (token: string, path: string, method = "GET", foreign = false) => {
    const key = foreign ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }) : ec;
    const message = [
      { typ: "dpop+jwt", alg: "ES256", jwk: key.publicKey.export({ format: "jwk" }) },
      {
        htu: `${origin}${path}`,
        htm: method,
        iat: Math.floor(Date.now() / 1000),
        jti: randomUUID(),
        ath: createHash("sha256").update(token).digest("base64url"),
      },
    ]
      .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
      .join(".");
    return `${message}.${sign("sha256", Buffer.from(message), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  };
  const request = (
    token: string,
    path = "/mcp",
    method = "POST",
    dpop?: string,
    scheme = "DPoP",
    signal?: AbortSignal,
  ) =>
    new Request(`http://untrusted-forwarded.invalid${path}`, {
      method,
      signal,
      headers: {
        authorization: `${scheme} ${token}`,
        ...(dpop ? { dpop } : {}),
        "content-type": "application/json",
      },
      ...(method === "POST"
        ? {
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2026-07-28",
                capabilities: {},
                clientInfo: { name: "fixture", version: "1" },
              },
            }),
          }
        : {}),
    });
  const close = async () => {};
  return {
    origin,
    gate,
    admit,
    jwt,
    proof,
    request,
    requested,
    close,
    queries: () => queries,
    release: () => {
      mode = "keys";
      for (const resolve of stalled) resolve(keys());
    },
  };
}

describe("real OAuth resource I/O", () => {
  // Verification must never reach the network for its own signing keys.
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("OAuth verification must not fetch JWKS over HTTP");
      }),
    );
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("admits DPoP at MCP, asset and export paths with the canonical authority and actual method/path", async () => {
    const f = await fixture();
    try {
      const token = f.jwt();
      for (const [path, method] of [
        ["/mcp", "POST"],
        ["/kb-assets/kb/hash", "GET"],
        ["/kb-exports/kb/transfer", "GET"],
      ]) {
        await expect(
          f.admit(f.request(token, path, method, f.proof(token, path!, method))),
        ).resolves.toBeDefined();
      }
      expect(f.queries()).toBeGreaterThan(0);
      const endpoint = createMcpEndpoint({
        admit: f.admit,
        gate: f.gate,
        origin: f.origin,
        // The live KB mapping is SQL this fixture's query does not model.
        discover: async (actor, publish) =>
          publish(
            buildDiscovery({
              toolGroups: (await actor.recheck()).toolGroups ?? [],
              scopes: actor.principal.scopes,
              aclBits: ["read"],
              allowCreate: false,
              createdKbBits: [],
              kbs: null,
            }),
          ),
      });
      try {
        for (const method of ["server/discover", "tools/list"]) {
          const response = await endpoint.fetch(
            new Request(`${f.origin}/mcp`, {
              method: "POST",
              headers: {
                authorization: `DPoP ${token}`,
                dpop: f.proof(token, "/mcp", "POST"),
                "content-type": "application/json",
                "mcp-method": method,
                "mcp-protocol-version": "2026-07-28",
              },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method,
                params: {
                  _meta: {
                    [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
                    [CLIENT_INFO_META_KEY]: { name: "fixture", version: "1" },
                    [CLIENT_CAPABILITIES_META_KEY]: {},
                  },
                },
              }),
            }),
          );
          expect(response.status).toBe(200);
          const body = (await response.json()) as { error?: unknown; result: { tools: unknown[] } };
          expect(body.error).toBeUndefined();
          // The fixture grant holds read and export; discovery lists them plus KB lookup.
          if (method === "tools/list") expect(body.result.tools).toHaveLength(11);
        }
      } finally {
        await endpoint.close();
      }
      const valid = f.proof(token, "/mcp", "POST");
      await f.admit(f.request(token, "/mcp", "POST", valid));
      for (const p of [
        undefined,
        valid,
        f.proof(token, "/mcp", "POST", true),
        f.proof(token, "/wrong", "POST"),
        f.proof(token, "/mcp", "GET"),
      ]) {
        await expect(f.admit(f.request(token, "/mcp", "POST", p))).rejects.toMatchObject({
          code: "UNAUTHORIZED",
        });
      }
      await expect(
        f.admit(f.request(token, "/mcp", "POST", f.proof(token, "/mcp", "POST"), "Bearer")),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(f.admit(f.request(token), { selfRevoke: true })).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      await expect(
        f.admit(f.request(f.jwt(false), "/mcp", "POST", undefined, "Bearer")),
      ).resolves.toBeDefined();
    } finally {
      await f.close();
    }
  });
  it("serves legacy 2025-06-18 initialize, notifications/initialized, tools/list, and tools/call under real OAuth DPoP, OAuth Bearer, and PAT admission", async () => {
    const previousRecovery = kbRecoveryGateOpen();
    setKbRecoveryComplete(true);
    const f = await fixture();
    const kbId = "a".repeat(24);
    const kbRow = {
      id: kbId,
      slug: "notes",
      name: "Notes",
      description: "Integration fixture KB",
      ownerId: "owner",
      state: "ACTIVE" as const,
      headSha: "0".repeat(40),
      activeGenerationId: null,
      metadataVersion: 1,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
    };
    const runtime = () =>
      ({
        canonicalOrigin: f.origin,
        prisma: {
          $queryRaw: async (strings: TemplateStringsArray) => {
            const sql = strings.join(" ");
            if (sql.includes("grant_kb_acl") && sql.includes("array_agg")) {
              return [{ kbId, bits: ["read"] }];
            }
            return [kbRow];
          },
          knowledgeBase: {
            findUnique: async () => ({ id: kbId, ownerId: "owner", state: "ACTIVE" }),
          },
          kbShare: {
            findUnique: async () => null,
          },
          user: {
            findUnique: async () => ({
              banned: false,
              banExpires: null,
              twoFactorEnabled: true,
              role: "user",
              createdAt: new Date(0),
              twoFactorGraceStartedAt: null,
            }),
          },
          appSetting: {
            findMany: async () => [],
          },
        },
      }) as unknown as KbRuntimeConfig;

    // Extend the fixture query with a live PAT row and grant ACL bits so PAT, OAuth Bearer, and OAuth DPoP all run end-to-end.
    const pat = generatePatSecret();
    const patGrantId = randomUUID();
    const oauthToken = f.jwt();
    const bearerToken = f.jwt(false);
    const apiKey = generateApiKeySecret();
    let patRevoked = false;
    const patQuery: LockQuery = async <R>(sql: string) => ({
      rows: (sql.includes('FROM "mcp_personal_token"')
        ? patRevoked
          ? []
          : [
              {
                id: "pat-1",
                grantId: patGrantId,
                userId: "owner",
                kind: "PAT",
                clientId: "pat:pat-1",
                scopes: ["mcp:read"],
                toolGroups: ["read", "export"],
                secretDigest: digestPatSecret(pat.secret),
                expiresAt: new Date("2099-01-01"),
                revokedAt: null,
                tokenRevokedAt: null,
                tokenExpiresAt: new Date("2099-01-01"),
                tokenId: "pat-1",
                resource: `${f.origin}/mcp`,
                parentApiKeyId: null,
                parentLive: null,
                apiKeyId: null,
                apiKeyLive: null,
              },
            ]
        : sql.includes('FROM "grant_kb_acl"')
          ? [{ bits: ["read"] }]
          : sql.includes('FROM "mcp_grant"')
            ? [
                {
                  id: patGrantId,
                  kind: "PAT",
                  userId: "owner",
                  clientId: "pat:pat-1",
                  scopes: ["mcp:read"],
                  toolGroups: ["read", "export"],
                  revokedAt: patRevoked ? new Date() : null,
                  tokenRevokedAt: patRevoked ? new Date() : null,
                  tokenExpiresAt: new Date("2099-01-01"),
                  tokenId: "pat-1",
                  resource: `${f.origin}/mcp`,
                  parentApiKeyId: null,
                  parentLive: null,
                  apiKeyId: null,
                  apiKeyLive: null,
                },
              ]
            : sql.includes('FROM "user"')
              ? [{ banned: false, twoFactorEnabled: true }]
              : []) as R[],
      rowCount: 1,
    });
    const patGate = createAdmissionGate();
    const patAdmit = createBearerAdmission({
      origin: f.origin,
      query: patQuery,
      gate: patGate,
      isClosing: () => patGate.closed,
    });
    const sseJson = async (response: Response) => {
      expect(response.headers.get("content-type")).toMatch(/^text\/event-stream\b/i);
      const text = await response.text();
      const data = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .pop();
      return JSON.parse(data!) as Record<string, unknown>;
    };
    const makeEndpoint = (admit: typeof f.admit, gate: typeof f.gate) =>
      createMcpEndpoint({
        admit,
        gate,
        origin: f.origin,
        runtime,
        masterKey: () => undefined,
        discover: async (actor, publish) =>
          publish(
            buildDiscovery({
              toolGroups: (await actor.recheck()).toolGroups ?? [],
              scopes: actor.principal.scopes,
              aclBits: ["read"],
              allowCreate: false,
              createdKbBits: [],
              kbs: null,
            }),
          ),
      });
    try {
      const oauthEndpoint = makeEndpoint(f.admit, f.gate);
      const patEndpoint = makeEndpoint(patAdmit, patGate);
      try {
        // 1. OAuth DPoP full lifecycle including real tools/call.
        const dpopHeaders = (extra: Record<string, string> = {}) => ({
          authorization: `DPoP ${oauthToken}`,
          dpop: f.proof(oauthToken, "/mcp", "POST"),
          accept: "text/event-stream, application/json",
          "content-type": "application/json",
          ...extra,
        });
        const initRes = await oauthEndpoint.fetch(
          new Request(`${f.origin}/mcp`, {
            method: "POST",
            headers: dpopHeaders(),
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "codex-mcp-client", version: "0.172.0" },
              },
            }),
          }),
        );
        expect(initRes.status).toBe(200);
        expect(initRes.headers.get("cache-control")).toBe("private, no-store");
        expect(await sseJson(initRes)).toMatchObject({
          result: { protocolVersion: "2025-06-18", serverInfo: { name: "knowledge-base" } },
        });

        const notifRes = await oauthEndpoint.fetch(
          new Request(`${f.origin}/mcp`, {
            method: "POST",
            headers: dpopHeaders({ "mcp-protocol-version": "2025-06-18" }),
            body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
          }),
        );
        expect(notifRes.status).toBe(202);
        expect(await notifRes.text()).toBe("");

        const listRes = await oauthEndpoint.fetch(
          new Request(`${f.origin}/mcp`, {
            method: "POST",
            headers: dpopHeaders({ "mcp-protocol-version": "2025-06-18" }),
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
          }),
        );
        expect(listRes.status).toBe(200);
        const listBody = (await sseJson(listRes)) as { result: { tools: unknown[] } };
        expect(listBody.result.tools).toHaveLength(11);

        // OAuth DPoP tools/call returns the real kb/1 list result with the fixture KB.
        const dpopCallRes = await oauthEndpoint.fetch(
          new Request(`${f.origin}/mcp`, {
            method: "POST",
            headers: dpopHeaders({ "mcp-protocol-version": "2025-06-18" }),
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 3,
              method: "tools/call",
              params: { name: "knowledge_bases_list", arguments: {} },
            }),
          }),
        );
        expect(dpopCallRes.status).toBe(200);
        const dpopCallBody = (await sseJson(dpopCallRes)) as {
          result: {
            isError: boolean;
            structuredContent: {
              schemaVersion: string;
              data: { items: { id: string; name: string }[] };
            };
          };
        };
        expect(dpopCallBody.result.isError).toBe(false);
        expect(dpopCallBody.result.structuredContent.schemaVersion).toBe("kb/1");
        expect(dpopCallBody.result.structuredContent.data.items).toHaveLength(1);
        expect(dpopCallBody.result.structuredContent.data.items[0]).toMatchObject({
          id: kbId,
          name: "Notes",
        });

        // 2. OAuth Bearer (unbound JWT) legacy tools/call returns the real fixture KB.
        const bearerCallRes = await oauthEndpoint.fetch(
          new Request(`${f.origin}/mcp`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${bearerToken}`,
              accept: "text/event-stream, application/json",
              "content-type": "application/json",
              "mcp-protocol-version": "2025-06-18",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 4,
              method: "tools/call",
              params: { name: "knowledge_bases_list", arguments: {} },
            }),
          }),
        );
        expect(bearerCallRes.status).toBe(200);
        const bearerCallBody = (await sseJson(bearerCallRes)) as {
          result: {
            isError: boolean;
            structuredContent: {
              schemaVersion: string;
              data: { items: { id: string; name: string }[] };
            };
          };
        };
        expect(bearerCallBody.result.isError).toBe(false);
        expect(bearerCallBody.result.structuredContent.schemaVersion).toBe("kb/1");
        expect(bearerCallBody.result.structuredContent.data.items).toHaveLength(1);
        expect(bearerCallBody.result.structuredContent.data.items[0]).toMatchObject({
          id: kbId,
          name: "Notes",
        });

        // 3. PAT legacy initialize -> tools/list -> tools/call returning real fixture KB, then denied when revoked.
        const patHeaders = (extra: Record<string, string> = {}) => ({
          authorization: `Bearer ${pat.secret}`,
          accept: "text/event-stream, application/json",
          "content-type": "application/json",
          ...extra,
        });
        const patCallRes = await patEndpoint.fetch(
          new Request(`${f.origin}/mcp`, {
            method: "POST",
            headers: patHeaders({ "mcp-protocol-version": "2025-06-18" }),
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 5,
              method: "tools/call",
              params: { name: "knowledge_bases_list", arguments: {} },
            }),
          }),
        );
        expect(patCallRes.status).toBe(200);
        const patCallBody = (await sseJson(patCallRes)) as {
          result: {
            isError: boolean;
            structuredContent: {
              schemaVersion: string;
              data: { items: { id: string; name: string }[] };
            };
          };
        };
        expect(patCallBody.result.isError).toBe(false);
        expect(patCallBody.result.structuredContent.data.items).toHaveLength(1);
        expect(patCallBody.result.structuredContent.data.items[0]).toMatchObject({
          id: kbId,
          name: "Notes",
        });

        patRevoked = true;
        const patRevokedRes = await patEndpoint.fetch(
          new Request(`${f.origin}/mcp`, {
            method: "POST",
            headers: patHeaders({ "mcp-protocol-version": "2025-06-18" }),
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 6,
              method: "tools/call",
              params: { name: "knowledge_bases_list", arguments: {} },
            }),
          }),
        );
        expect(patRevokedRes.status).toBe(401);

        // 4. Refusals: missing token, cookie-only request, and REST API key all get 401 with WWW-Authenticate.
        for (const headers of [
          {
            accept: "text/event-stream, application/json",
            "content-type": "application/json",
            "mcp-protocol-version": "2025-06-18",
          },
          {
            cookie: "better-auth.session_token=forged-browser-cookie",
            accept: "text/event-stream, application/json",
            "content-type": "application/json",
            "mcp-protocol-version": "2025-06-18",
          },
          {
            authorization: `Bearer ${apiKey.secret}`,
            accept: "text/event-stream, application/json",
            "content-type": "application/json",
            "mcp-protocol-version": "2025-06-18",
          },
        ]) {
          const refused = await oauthEndpoint.fetch(
            new Request(`${f.origin}/mcp`, {
              method: "POST",
              headers,
              body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list", params: {} }),
            }),
          );
          expect(refused.status).toBe(401);
          expect(refused.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
        }

        // 5. Authenticated batch on legacy request is refused 400 -32600.
        const batchRes = await oauthEndpoint.fetch(
          new Request(`${f.origin}/mcp`, {
            method: "POST",
            headers: dpopHeaders({ "mcp-protocol-version": "2025-06-18" }),
            body: JSON.stringify([{ jsonrpc: "2.0", id: 8, method: "tools/list", params: {} }]),
          }),
        );
        expect(batchRes.status).toBe(400);
        expect(await batchRes.json()).toMatchObject({ error: { code: -32600 } });
      } finally {
        await oauthEndpoint.close();
        await patEndpoint.close();
      }
    } finally {
      setKbRecoveryComplete(previousRecovery);
      await f.close();
    }
  });
  it("returns redacted AUTH_UNAVAILABLE for key-store failure and 401 for invalid claims/signatures", async () => {
    const bad = await fixture("failure");
    const good = await fixture();
    try {
      const gate = bad.gate;
      const endpoint = createMcpEndpoint({ admit: bad.admit, gate, origin: bad.origin });
      const response = await endpoint.fetch(
        bad.request(bad.jwt(false), "/mcp", "POST", undefined, "Bearer"),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "AUTH_UNAVAILABLE" });
      expect(response.headers.has("www-authenticate")).toBe(false);
      expect(gate.outstanding).toBe(0);
      await endpoint.close();
      for (const patch of [
        { iss: "http://foreign.invalid" },
        { aud: "http://foreign.invalid/mcp" },
        { exp: 1 },
      ]) {
        await expect(
          good.admit(good.request(good.jwt(false, patch), "/mcp", "POST", undefined, "Bearer")),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      }
      const signed = bad.jwt(false); // Different signing key, same kid.
      await expect(
        good.admit(good.request(signed, "/mcp", "POST", undefined, "Bearer")),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      await bad.close();
      await good.close();
    }
  });
  it("cancels an actually stalled key-store read at the production 30-second admission deadline", async () => {
    const f = await fixture("stall");
    const gate = f.gate;
    const endpoint = createMcpEndpoint({ admit: f.admit, gate, origin: f.origin });
    try {
      const started = Date.now();
      const response = await endpoint.fetch(
        f.request(f.jwt(false), "/mcp", "POST", undefined, "Bearer"),
      );
      expect(response.status).toBe(503);
      expect(Date.now() - started).toBeLessThan(32_000);
      // The caller has its 503, but the uncancellable key read is still owned.
      await new Promise((r) => setTimeout(r, 50));
      expect(gate.outstanding).toBe(1);
      const closing = gate.close();
      f.release();
      await closing;
      expect(gate.outstanding).toBe(0);
    } finally {
      await endpoint.close();
      await f.close();
    }
  }, 40_000);
  it.each([
    ["disconnect", "stall"],
    ["close", "stall"],
  ] as const)(
    "joins stalled JWKS on %s (%s), refuses re-entry, and observes pre-abort",
    async (mode, stage) => {
      const f = await fixture(stage);
      const gate = f.gate;
      const endpoint = createMcpEndpoint({ admit: f.admit, gate, origin: f.origin });
      try {
        const controller = new AbortController();
        const pending = endpoint.fetch(
          f.request(f.jwt(false), "/mcp", "POST", undefined, "Bearer", controller.signal),
        );
        await f.requested;
        // The endpoint request and the bearer verification each hold a permit.
        expect(gate.outstanding).toBe(2);
        const started = Date.now();
        const closing = mode === "close" ? gate.close() : undefined;
        if (mode === "disconnect") controller.abort();
        expect((await pending).status).toBe(503);
        expect(Date.now() - started).toBeLessThan(2_000);
        // Answered promptly, yet the in-flight key read keeps its permit: a
        // close must not report drained while it can still touch the database.
        let drained = false;
        void closing?.then(() => {
          drained = true;
        });
        await new Promise((r) => setTimeout(r, 50));
        expect(gate.outstanding).toBe(1);
        expect(drained).toBe(false);
        f.release();
        await (closing ?? vi.waitFor(() => expect(gate.outstanding).toBe(0)));
        expect(gate.outstanding).toBe(0);
        if (mode === "disconnect")
          await expect(
            f.admit(f.request(f.jwt(false), "/mcp", "POST", undefined, "Bearer")),
          ).resolves.toBeDefined();
        controller.abort();
        expect(
          (
            await endpoint.fetch(
              f.request(f.jwt(false), "/mcp", "POST", undefined, "Bearer", controller.signal),
            )
          ).status,
        ).toBe(503);
        await gate.close();
        expect(
          (await endpoint.fetch(f.request(f.jwt(false), "/mcp", "POST", undefined, "Bearer")))
            .status,
        ).toBe(503);
      } finally {
        await endpoint.close();
        await f.close();
      }
    },
  );
});
