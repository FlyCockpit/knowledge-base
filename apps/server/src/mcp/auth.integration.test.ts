import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { LockQuery } from "@knowledge-base/api/lib/kb/lock";
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
          if (method === "tools/list") expect(body.result.tools).toHaveLength(8);
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
