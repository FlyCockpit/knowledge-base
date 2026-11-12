import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import type { LockQuery } from "@knowledge-base/api/lib/kb/lock";
import { authorize, type LiveAuthorityStore } from "@knowledge-base/api/lib/kb/permissions";
import { digestPatSecret, generatePatSecret } from "@knowledge-base/api/lib/mcp-token-access";
import { captureLog } from "@knowledge-base/env/log";
import { describe, expect, it, vi } from "vitest";
import { createAdmissionGate } from "./admission";
import { createBearerAdmission, oauthVerifier } from "./auth";
import { AuthServiceUnavailableError, admissionErrorResponse } from "./errors";

// The default JWKS loader reads Better Auth's in-process key store lazily.
const authApi = vi.hoisted(() => ({
  getJwks: async (): Promise<unknown> => {
    throw new Error("getJwks not stubbed");
  },
}));
vi.mock("@knowledge-base/auth", () => ({ auth: { api: authApi } }));

// The bearer settler owns a separate authority transaction. Unit tests isolate
// its connection; real policy/transaction interleavings run in the grants suite.
vi.mock("@knowledge-base/db", () => ({
  default: {
    $transaction: async (run: (tx: object) => Promise<unknown>) =>
      run({
        $executeRaw: async () => 0,
        $executeRawUnsafe: async () => 0,
      }),
  },
}));

const origin = "https://kb.example.invalid";
function fixture(kind: "PAT" | "OAUTH" = "PAT") {
  const secret = generatePatSecret();
  const grant = {
    id: randomUUID(),
    userId: "owner",
    kind,
    clientId: kind === "PAT" ? "pat:t" : "client",
    scopes: ["mcp:write"],
    toolGroups: ["read", "edit"] as string[],
    revokedAt: null as Date | null,
    tokenRevokedAt: null as Date | null,
    tokenExpiresAt: new Date("2099-01-01"),
    tokenId: "t",
    resource: `${origin}/mcp`,
  };
  const token = {
    ...grant,
    id: "t",
    grantId: grant.id,
    secretDigest: digestPatSecret(secret.secret),
    expiresAt: grant.tokenExpiresAt,
    resource: `${origin}/mcp`,
  };
  const user = {
    banned: false,
    banExpires: null,
    twoFactorEnabled: true,
    role: "admin",
    createdAt: new Date(0),
    forceInternal: "true",
    forcePublic: "false",
  };
  let bits = ["manage"];
  let closing = false;
  const query: LockQuery = async <R>(sql: string) => ({
    rows: (sql.includes('FROM "mcp_personal_token"')
      ? [token]
      : sql.includes('FROM "mcp_grant"')
        ? [grant]
        : sql.includes('FROM "grant_kb_acl"')
          ? [{ bits }]
          : sql.includes('FROM "user"')
            ? [user]
            : []) as R[],
    rowCount: 1,
  });
  const claims = {
    sub: "owner",
    client_id: "client",
    mcp_grant_id: String(grant.id),
    scope: "mcp:write",
    aud: `${origin}/mcp`,
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  const verifyOAuth = vi.fn(async (_request: Request) => claims);
  const admit = createBearerAdmission({
    query,
    origin,
    isClosing: () => closing,
    verifyOAuth,
  });
  const request = () =>
    new Request(`${origin}/mcp`, {
      headers: {
        authorization: `Bearer ${kind === "PAT" ? secret.secret : "oauth-fixture"}`,
        cookie: "session=ignored",
      },
    });
  const store: LiveAuthorityStore = {
    loadKb: async () => ({ id: "kb", ownerId: "owner", state: "ACTIVE" }),
    loadShare: async () => ({ bits: ["write"], revokedAt: null }),
    loadIdentity: async () => ({ banned: false, twoFactorSatisfied: true, instanceEnabled: true }),
  };
  return {
    admit,
    query,
    request,
    grant,
    token,
    user,
    claims,
    verifyOAuth,
    store,
    setBits: (value: string[]) => {
      bits = value;
    },
    close: () => {
      closing = true;
    },
  };
}

describe("unified credential admission", () => {
  it("settles an aborted caller while retaining noncooperative I/O ownership across a successor and close", async () => {
    const f = fixture();
    const gate = createAdmissionGate();
    let unblock!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const blocked = new Promise<void>((r) => {
      unblock = r;
    });
    let first = true;
    const admit = createBearerAdmission({
      origin,
      gate,
      withQuery: async (_signal, run) => {
        if (first) {
          first = false;
          entered();
          await blocked;
        }
        return run(f.query);
      },
    });
    const controller = new AbortController();
    const old = admit(new Request(f.request(), { signal: controller.signal }));
    const rejected = expect(old).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    await ready;
    controller.abort();
    await rejected;
    expect(gate.outstanding).toBe(1);
    await expect(admit(f.request())).resolves.toBeDefined();
    expect(gate.outstanding).toBe(1);
    let closed = false;
    const closing = gate.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    unblock();
    await closing;
    expect(gate.outstanding).toBe(0);
    await expect(admit(f.request())).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });

  it("carries OAuth proof with canonical URL and keeps PATs bearer-only", async () => {
    const f = fixture("OAUTH");
    await expect(
      f.admit(
        new Request("https://spoof.invalid/mcp", {
          method: "POST",
          headers: { authorization: "DPoP oauth-fixture", dpop: "proof", cookie: "ignored" },
        }),
      ),
    ).resolves.toBeDefined();
    const forwarded = f.verifyOAuth.mock.calls[0]?.[0];
    expect(forwarded?.url).toBe(`${origin}/mcp`);
    expect(forwarded?.headers.get("dpop")).toBe("proof");
    expect(forwarded?.headers.get("cookie")).toBeNull();
    const pat = fixture();
    const bearer = pat.request();
    await expect(pat.admit(bearer)).resolves.toBeDefined();
    const headers = new Headers(bearer.headers);
    headers.set("authorization", headers.get("authorization")!.replace("Bearer", "DPoP"));
    await expect(pat.admit(new Request(bearer, { headers }))).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it("executes OAuth signature/issuer/audience/expiry checks with disposable signing keys", async () => {
    const issuerOrigin = `https://${randomUUID()}.example.invalid`;
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    // Keys come from the in-process Better Auth store, never the public origin.
    const fetch = vi.fn(async () => {
      throw new Error("OAuth verification must not fetch its own origin");
    });
    vi.stubGlobal("fetch", fetch);
    const getJwks = vi.fn(async () => ({
      keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" }],
    }));
    authApi.getJwks = getJwks;
    const claims = {
      iss: `${issuerOrigin}/api/auth`,
      aud: `${issuerOrigin}/mcp`,
      sub: "fixture",
      client_id: "client",
      exp: Math.floor(Date.now() / 1000) + 60,
    };
    const token = (patch: object = {}) => {
      const message = [
        { alg: "RS256", kid: "fixture", typ: "JWT" },
        { ...claims, ...patch },
      ]
        .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
        .join(".");
      return `${message}.${sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64url")}`;
    };
    const verify = (raw: string) =>
      oauthVerifier(issuerOrigin, async () => {
        throw new Error("Unbound bearer must not reserve DPoP");
      })(new Request(`${issuerOrigin}/mcp`, { headers: { authorization: `Bearer ${raw}` } }));
    try {
      await expect(verify(token())).resolves.toMatchObject({ sub: "fixture" });
      for (const patch of [
        { iss: "https://foreign.invalid" },
        { aud: "https://foreign.invalid/mcp" },
        { exp: 1 },
      ])
        await expect(verify(token(patch))).rejects.toBeDefined();
      const raw = token();
      const signatureStart = raw.lastIndexOf(".") + 1;
      await expect(
        verify(
          `${raw.slice(0, signatureStart)}${raw[signatureStart] === "a" ? "b" : "a"}${raw.slice(signatureStart + 1)}`,
        ),
      ).rejects.toBeDefined();
      expect(getJwks).toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("names key-service failures AUTH_UNAVAILABLE with a server log line, never the cause", async () => {
    const issuerOrigin = `https://${randomUUID()}.example.invalid`;
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const message = [
      { alg: "RS256", kid: "fixture", typ: "JWT" },
      { iss: `${issuerOrigin}/api/auth`, aud: `${issuerOrigin}/mcp`, sub: "fixture", exp: 4e9 },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".");
    const token = `${message}.${sign("RSA-SHA256", Buffer.from(message), privateKey).toString("base64url")}`;
    const canaryPat = `kbp_${"c".repeat(16)}_${"d".repeat(43)}`;
    const log = captureLog();
    try {
      for (const loadJwks of [
        async () => {
          throw new Error(`private key-store canary ${canaryPat}`);
        },
        async () => ({ keys: "not-a-key-set" }),
      ]) {
        log.records.length = 0;
        const error = await oauthVerifier(
          issuerOrigin,
          async () => {
            throw new Error("Unbound bearer must not reserve DPoP");
          },
          loadJwks,
        )(
          new Request(`${issuerOrigin}/mcp`, { headers: { authorization: `Bearer ${token}` } }),
        ).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AuthServiceUnavailableError);
        expect(error).toMatchObject({ code: "STORAGE_UNAVAILABLE" });
        expect(log.records).toHaveLength(1);
        const line = JSON.stringify(log.records[0]);
        expect(JSON.parse(line)).toMatchObject({
          site: "mcp.oauth",
          message: "signing-key service unavailable",
        });
        // A fixed record: the loader's message (and its PAT) never prints.
        expect(line).not.toContain(canaryPat);
        expect(line).not.toContain("canary");
        const response = admissionErrorResponse(error, issuerOrigin);
        expect(response.status).toBe(503);
        const body = await response.text();
        expect(JSON.parse(body)).toEqual({ error: "AUTH_UNAVAILABLE" });
        expect(body).not.toContain("canary");
      }
      // A client disconnect is not an outage: no log line. The verification
      // still settles only when the uncancellable key read does.
      log.records.length = 0;
      const controller = new AbortController();
      let failLoad!: (error: Error) => void;
      let settled = false;
      const pending = oauthVerifier(
        issuerOrigin,
        async () => {
          throw new Error("Unbound bearer must not reserve DPoP");
        },
        () =>
          new Promise((_resolve, reject) => {
            failLoad = reject;
          }),
      )(
        new Request(`${issuerOrigin}/mcp`, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        }),
      ).finally(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(failLoad).toBeTypeOf("function"));
      controller.abort();
      await new Promise((r) => setTimeout(r, 20));
      expect(settled).toBe(false);
      failLoad(new Error("connection closed during shutdown"));
      await expect(pending).rejects.toBeInstanceOf(AuthServiceUnavailableError);
      expect(log.records).toEqual([]);
    } finally {
      log.restore();
    }
  });
  it("rejects cookies and malformed credentials without OAuth or database fallback", async () => {
    const f = fixture();
    for (const authorization of [
      undefined,
      "Basic xxx",
      "Bearer",
      "Bearer x y",
      "Bearer kbp_invalid",
    ]) {
      await expect(
        f.admit(
          new Request(`${origin}/mcp`, {
            headers: { cookie: "session=valid", ...(authorization ? { authorization } : {}) },
          }),
        ),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    }
    expect(f.verifyOAuth).not.toHaveBeenCalled();
  });
  for (const kind of ["PAT", "OAUTH"] as const) {
    it(`${kind}: crosses scope, stored ACL and live rights without owner elevation`, async () => {
      const f = fixture(kind);
      const actor = await f.admit(f.request());
      const can = (operation: "read" | "write") =>
        authorize({ ...actor, kbId: "kb", operation, store: f.store });
      await expect(can("write")).resolves.toBeDefined();
      f.setBits(["read"]);
      await expect(can("read")).resolves.toBeDefined();
      await expect(can("write")).rejects.toMatchObject({ code: "FORBIDDEN" });
      f.setBits([]);
      await expect(can("read")).rejects.toMatchObject({ code: "NOT_FOUND" });
      f.setBits(["manage"]);
      actor.principal.scopes = ["mcp:read"];
      f.grant.scopes.push("mcp:read");
      await expect(can("write")).rejects.toMatchObject({ code: "FORBIDDEN" });
      actor.principal.scopes = ["mcp:write"];
      f.store.loadKb = async () => ({ id: "kb", ownerId: "other", state: "ACTIVE" });
      f.store.loadShare = async () => null;
      await expect(can("read")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    it.each(["revoked", "expired", "ban", "2fa", "subject", "client", "scope", "groups", "kind"])(
      `${kind}: rejects live %s loss after admission`,
      async (loss) => {
        const f = fixture(kind);
        const actor = await f.admit(f.request());
        if (loss === "revoked") f.grant.revokedAt = new Date();
        if (loss === "expired") actor.principal.expiresAt = new Date(0);
        if (loss === "ban") f.user.banned = true;
        if (loss === "2fa") f.user.twoFactorEnabled = false;
        if (loss === "subject") f.grant.userId = "other";
        if (loss === "client") f.grant.clientId = "other";
        if (loss === "scope") f.grant.scopes = [];
        if (loss === "groups") f.grant.toolGroups = [];
        if (loss === "kind") f.grant.kind = kind === "PAT" ? "OAUTH" : "PAT";
        await expect(actor.recheck()).rejects.toBeDefined();
      },
    );
  }
  it("binds PAT resource, OAuth generation and client; closed admission fences late work", async () => {
    const pat = fixture();
    pat.token.resource = "https://other.invalid/mcp";
    await expect(pat.admit(pat.request())).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    for (const key of ["mcp_grant_id", "client_id", "sub", "aud"] as const) {
      const f = fixture("OAUTH");
      f.claims[key] = key === "mcp_grant_id" ? randomUUID() : "wrong";
      await expect(f.admit(f.request())).rejects.toBeDefined();
    }
    const f = fixture("OAUTH");
    f.verifyOAuth.mockImplementation(async () => {
      f.close();
      return f.claims;
    });
    await expect(f.admit(f.request())).rejects.toBeDefined();
  });
});
