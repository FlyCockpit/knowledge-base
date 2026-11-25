import { resolve } from "node:path";
import { CredentialCapacityError } from "@knowledge-base/api/lib/kb/credential-query";
import { KbDomainError } from "@knowledge-base/api/lib/kb/errors";
import { KbAdmissionError, type TokenPrincipal } from "@knowledge-base/api/lib/kb/principal";
import { captureLog } from "@knowledge-base/env/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAdmissionGate } from "./mcp/admission";
import type { BearerAdmission } from "./mcp/context";

// The REST layer is thin: every route calls a domain function. Those are
// mocked here; their authority rules run against Postgres in the grants suite.
vi.mock("@knowledge-base/api/lib/api-keys", async (original) => ({
  ...(await original<typeof import("@knowledge-base/api/lib/api-keys")>()),
  describeApiKey: vi.fn(),
  assertApiKeyMayDelete: vi.fn(),
  listApiKeyChildren: vi.fn(),
  mintApiKeyChild: vi.fn(),
  revokeApiKeyChild: vi.fn(),
  touchApiKey: vi.fn(async () => {}),
}));
vi.mock("@knowledge-base/api/lib/kb/bases", async (original) => ({
  ...(await original<typeof import("@knowledge-base/api/lib/kb/bases")>()),
  createKnowledgeBaseAsGrant: vi.fn(),
  deleteKnowledgeBase: vi.fn(),
  getKnowledgeBaseAttachment: vi.fn(),
  listKnowledgeBases: vi.fn(),
}));

const keys = await import("@knowledge-base/api/lib/api-keys");
const bases = await import("@knowledge-base/api/lib/kb/bases");
const { buildOpenApiDocument, createRestApi, REST_ROUTES, restLimiterRefusal } = await import(
  "./rest-api"
);

const origin = "https://kb.example.invalid";
const KB = "a".repeat(24);
const TOKEN = "b".repeat(24);

function principal(credential: TokenPrincipal["credential"]): TokenPrincipal {
  return {
    kind: "token",
    userId: "owner",
    grantId: "11111111-1111-4111-8111-111111111111",
    grantGeneration: "11111111-1111-4111-8111-111111111111",
    scopes: ["mcp:write"],
    expiresAt: new Date("2099-01-01"),
    storedAcl: new Map(),
    credential,
  };
}
const keyCredential = {
  kind: "API_KEY" as const,
  clientId: `apikey:${"k".repeat(24)}`,
  resource: `${origin}/api/v1`,
  tokenId: "k".repeat(24),
};

function setup(options: { closing?: boolean; setting?: string } = {}) {
  const admitted = (p: TokenPrincipal) =>
    ({
      principal: p,
      verifier: { inspect: vi.fn() },
      recheck: vi.fn(),
      demandToolGroups: vi.fn(),
      demandAuthoring: vi.fn(),
    }) as unknown as BearerAdmission;
  const admit = vi.fn(async (_request: Request) => admitted(principal(keyCredential)));
  const gate = createAdmissionGate();
  let closing = options.closing ?? false;
  const queryRawUnsafe = vi.fn(async (_sql: string, key: unknown) =>
    key === "kb.limits.createsPerHour" && options.setting ? [{ value: options.setting }] : [],
  );
  const runtime = { prisma: { $queryRawUnsafe: queryRawUnsafe }, canonicalOrigin: origin };
  const app = createRestApi({
    admit,
    runtime: () => runtime as never,
    origin,
    gate,
    isClosing: () => closing,
  });
  const call = (
    method: string,
    path: string,
    init: { body?: string; headers?: Record<string, string> } = {},
  ) =>
    app.request(`/api/v1${path}`, {
      method,
      headers: { authorization: "Bearer kbk_fixture", ...init.headers },
      body: init.body,
    });
  const json = (key = "idem-1") => ({
    "content-type": "application/json",
    "idempotency-key": key,
  });
  return {
    app,
    admit,
    admitted,
    gate,
    call,
    json,
    runtime,
    close: () => {
      closing = true;
    },
  };
}

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string } }).error;

const createBody = JSON.stringify({
  name: "Project 42",
  slug: "project-42",
  description: "Notes for project 42.",
});
const mintBody = JSON.stringify({ name: "agent", bits: ["propose"], toolGroups: ["read", "edit"] });
const deleteBody = JSON.stringify({ metadataVersion: 3, confirm: "DELETE" });

const domainMocks = () => [
  keys.describeApiKey,
  keys.assertApiKeyMayDelete,
  keys.listApiKeyChildren,
  keys.mintApiKeyChild,
  keys.revokeApiKeyChild,
  bases.createKnowledgeBaseAsGrant,
  bases.deleteKnowledgeBase,
  bases.getKnowledgeBaseAttachment,
  bases.listKnowledgeBases,
];
const expectNoDomainCall = () => {
  for (const fn of domainMocks()) expect(fn).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(bases.listKnowledgeBases).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(keys.listApiKeyChildren).mockResolvedValue({ items: [], nextCursor: null });
});

describe("REST control plane: admission", () => {
  it("answers 401 with WWW-Authenticate for any credential refusal, never saying why", async () => {
    const f = setup();
    for (const error of [
      new KbAdmissionError("UNAUTHORIZED", "denied"),
      new KbAdmissionError("FORBIDDEN", "two-factor"),
      new KbAdmissionError("NOT_FOUND", "gone"),
    ]) {
      f.admit.mockRejectedValueOnce(error);
      const response = await f.call("GET", "/kbs");
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="knowledge-base-api"');
      expect(await response.json()).toEqual({
        error: { code: "UNAUTHORIZED", message: "A valid REST API key is required" },
      });
    }
    expectNoDomainCall();
    expect(keys.touchApiKey).not.toHaveBeenCalled();
  });

  it("refuses a principal admitted as a PAT, an OAuth token or with no binding (401)", async () => {
    const f = setup();
    for (const credential of [
      { kind: "PAT" as const, clientId: "pat:t", resource: `${origin}/mcp`, tokenId: "t" },
      { kind: "OAUTH" as const, clientId: "client", resource: `${origin}/mcp` },
      { ...keyCredential, tokenId: undefined },
      undefined,
    ]) {
      f.admit.mockResolvedValueOnce(f.admitted(principal(credential)));
      expect((await f.call("GET", "/key")).status).toBe(401);
    }
    expectNoDomainCall();
    expect(keys.touchApiKey).not.toHaveBeenCalled();
  });

  it("answers a key that lost admission inside the domain transaction with 401, not 403", async () => {
    const f = setup();
    // The KB functions recheck the key on their own transaction and throw the
    // admission error as is (grants suite: a revoked key's principal).
    vi.mocked(bases.listKnowledgeBases).mockRejectedValueOnce(
      new KbAdmissionError("UNAUTHORIZED", "Credential is not admissible"),
    );
    const response = await f.call("GET", "/kbs");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("answers a key refused by its own control-plane transaction with 401", async () => {
    const f = setup();
    vi.mocked(keys.mintApiKeyChild).mockRejectedValueOnce(new keys.ApiKeyInadmissibleError());
    const response = await f.call("POST", `/kbs/${"a".repeat(24)}/tokens`, {
      headers: { "idempotency-key": "k1", "content-type": "application/json" },
      body: JSON.stringify({ name: "child", bits: ["read"], toolGroups: ["read"] }),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("tells a real 403 from a key that died while create/delete waited (folded into FORBIDDEN)", async () => {
    const refused = new KbDomainError("FORBIDDEN", "Forbidden");
    const body = JSON.stringify({ metadataVersion: 1, confirm: "DELETE" });
    // Still admissible on the live recheck: a permission denial.
    const denied = setup();
    vi.mocked(keys.assertApiKeyMayDelete).mockResolvedValueOnce();
    vi.mocked(bases.deleteKnowledgeBase).mockRejectedValueOnce(refused);
    const forbidden = await denied.call("DELETE", `/kbs/${"a".repeat(24)}`, {
      headers: denied.json("del-1"),
      body,
    });
    expect(forbidden.status).toBe(403);
    // The recheck fails: the key was revoked meanwhile, so 401 with a challenge.
    const died = setup();
    died.admit.mockImplementationOnce(async () => {
      const admission = {
        principal: principal(keyCredential),
        verifier: { inspect: vi.fn() },
        recheck: vi.fn(async () => {
          throw new KbAdmissionError("UNAUTHORIZED", "Credential is not admissible");
        }),
        demandToolGroups: vi.fn(),
        demandAuthoring: vi.fn(),
      };
      return admission as unknown as BearerAdmission;
    });
    vi.mocked(keys.assertApiKeyMayDelete).mockResolvedValueOnce();
    vi.mocked(bases.deleteKnowledgeBase).mockRejectedValueOnce(refused);
    const gone = await died.call("DELETE", `/kbs/${"a".repeat(24)}`, {
      headers: died.json("del-2"),
      body,
    });
    expect(gone.status).toBe(401);
    expect(gone.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("a raw credential-store error during the 403/401 recheck is a retryable 503, not a 500", async () => {
    const f = setup();
    f.admit.mockImplementationOnce(async () => {
      const admission = {
        principal: principal(keyCredential),
        verifier: { inspect: vi.fn() },
        recheck: vi.fn(async () => {
          throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        }),
        demandToolGroups: vi.fn(),
        demandAuthoring: vi.fn(),
      };
      return admission as unknown as BearerAdmission;
    });
    vi.mocked(keys.assertApiKeyMayDelete).mockResolvedValueOnce();
    vi.mocked(bases.deleteKnowledgeBase).mockRejectedValueOnce(
      new KbDomainError("FORBIDDEN", "Forbidden"),
    );
    const response = await f.call("DELETE", `/kbs/${"a".repeat(24)}`, {
      headers: f.json("del-4"),
      body: JSON.stringify({ metadataVersion: 1, confirm: "DELETE" }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("a busy credential store during the 403/401 recheck stays a retryable 503", async () => {
    const f = setup();
    f.admit.mockImplementationOnce(async () => {
      const admission = {
        principal: principal(keyCredential),
        verifier: { inspect: vi.fn() },
        recheck: vi.fn(async () => {
          throw new CredentialCapacityError();
        }),
        demandToolGroups: vi.fn(),
        demandAuthoring: vi.fn(),
      };
      return admission as unknown as BearerAdmission;
    });
    vi.mocked(keys.assertApiKeyMayDelete).mockResolvedValueOnce();
    vi.mocked(bases.deleteKnowledgeBase).mockRejectedValueOnce(
      new KbDomainError("FORBIDDEN", "Forbidden"),
    );
    const response = await f.call("DELETE", `/kbs/${"a".repeat(24)}`, {
      headers: f.json("del-3"),
      body: JSON.stringify({ metadataVersion: 1, confirm: "DELETE" }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
  });

  it("accepts a signed cursor as long as the shared bound (KB names are embedded)", async () => {
    const f = setup();
    vi.mocked(bases.listKnowledgeBases).mockResolvedValueOnce({ items: [], nextCursor: null });
    const cursor = "c".repeat(1000);
    expect((await f.call("GET", `/kbs?limit=1&cursor=${cursor}`)).status).toBe(200);
    expect(vi.mocked(bases.listKnowledgeBases).mock.calls.at(-1)?.[2]).toMatchObject({ cursor });
  });

  it("a credential store outage during admission is a retryable 503, never a 401", async () => {
    const f = setup();
    f.admit.mockRejectedValueOnce(
      Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    );
    const response = await f.call("GET", "/kbs");
    expect(response.status).toBe(503);
    expect(response.headers.get("www-authenticate")).toBeNull();
    expectNoDomainCall();
  });

  it("validates a child-list cursor as a token id (400, never 500)", async () => {
    const f = setup();
    expect((await f.call("GET", "/tokens?cursor=%00")).status).toBe(400);
    expect((await f.call("GET", `/tokens?cursor=${"G".repeat(24)}`)).status).toBe(400);
    expect((await f.call("GET", `/tokens?cursor=${"c".repeat(129)}`)).status).toBe(400);
    expect(
      (await f.call("GET", `/kbs/${"a".repeat(24)}/tokens?cursor=${"c".repeat(129)}`)).status,
    ).toBe(400);
    expect(keys.listApiKeyChildren).not.toHaveBeenCalled();
  });

  it("formats limiter refusals with the REST error contract", () => {
    expect(restLimiterRefusal(429, 7)).toEqual({
      error: { code: "RATE_LIMITED", message: "Rate limited", retryAfterSeconds: 7 },
    });
    expect(restLimiterRefusal(503, 5)).toMatchObject({ error: { code: "STORAGE_UNAVAILABLE" } });
  });

  it("busy credential connections are a short 503, not a refusal", async () => {
    const f = setup();
    f.admit.mockRejectedValueOnce(new CredentialCapacityError());
    const response = await f.call("GET", "/kbs");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
  });

  it("is 503 during shutdown and after the gate closes, before admission", async () => {
    const closing = setup({ closing: true });
    expect((await closing.call("GET", "/kbs")).status).toBe(503);
    expect(closing.admit).not.toHaveBeenCalled();
    const closed = setup();
    await closed.gate.close();
    expect((await closed.call("GET", "/kbs")).status).toBe(503);
    expect(closed.admit).not.toHaveBeenCalled();
    expectNoDomainCall();
  });

  it("releases its gate permit after every request", async () => {
    const f = setup();
    await f.call("GET", "/kbs");
    f.admit.mockRejectedValueOnce(new KbAdmissionError("UNAUTHORIZED", "x"));
    await f.call("GET", "/kbs");
    expect(f.gate.outstanding).toBe(0);
  });
});

describe("REST control plane: routing", () => {
  it("routes every operation to its domain function with the key principal and resource", async () => {
    const f = setup();
    const resource = `${origin}/api/v1`;
    vi.mocked(keys.describeApiKey).mockResolvedValue({
      id: "k",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    } as never);
    vi.mocked(bases.getKnowledgeBaseAttachment).mockResolvedValue({ id: KB } as never);
    vi.mocked(bases.createKnowledgeBaseAsGrant).mockResolvedValue({
      operationId: "op",
      kb: { id: KB },
    });
    vi.mocked(bases.deleteKnowledgeBase).mockResolvedValue({ operationId: "op", tombstoned: true });
    vi.mocked(keys.mintApiKeyChild).mockResolvedValue({
      token: { id: TOKEN, createdAt: new Date("2026-01-01T00:00:00Z") } as never,
      secret: "kbp_secret",
      replayed: false,
    });
    vi.mocked(keys.revokeApiKeyChild).mockResolvedValue({ id: TOKEN, revoked: true });

    const key = await f.call("GET", "/key");
    expect(key.status).toBe(200);
    expect(key.headers.get("cache-control")).toBe("no-store");
    expect(await key.json()).toEqual({ id: "k", createdAt: "2026-01-01T00:00:00.000Z" });
    const p = f.admit.mock.results[0]!.value as Promise<BearerAdmission>;
    const admittedPrincipal = (await p).principal;
    expect(keys.describeApiKey).toHaveBeenCalledWith(f.runtime, admittedPrincipal, resource);

    expect((await f.call("GET", "/kbs?limit=5&cursor=abc")).status).toBe(200);
    expect(vi.mocked(bases.listKnowledgeBases).mock.calls[0]?.[2]).toEqual({
      limit: 5,
      cursor: "abc",
    });

    expect((await f.call("GET", `/kbs/${KB}`)).status).toBe(200);
    expect(vi.mocked(bases.getKnowledgeBaseAttachment).mock.calls[0]?.[2]).toBe(KB);

    const created = await f.call("POST", "/kbs", { body: createBody, headers: f.json("c-1") });
    expect(created.status).toBe(201);
    expect(vi.mocked(bases.createKnowledgeBaseAsGrant).mock.calls[0]?.[3]).toEqual({
      ...JSON.parse(createBody),
      idempotencyKey: "c-1",
    });

    const deleted = await f.call("DELETE", `/kbs/${KB}`, {
      body: deleteBody,
      headers: f.json("d-1"),
    });
    expect(deleted.status).toBe(200);
    // The key's allowDelete gate runs before the delete itself.
    expect(keys.assertApiKeyMayDelete).toHaveBeenCalledWith(f.runtime, expect.anything(), resource);
    expect(vi.mocked(keys.assertApiKeyMayDelete).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(bases.deleteKnowledgeBase).mock.invocationCallOrder[0]!,
    );
    expect(vi.mocked(bases.deleteKnowledgeBase).mock.calls[0]?.[2]).toEqual({
      kbId: KB,
      metadataVersion: 3,
      confirm: "DELETE",
      idempotencyKey: "d-1",
    });

    const minted = await f.call("POST", `/kbs/${KB}/tokens`, {
      body: mintBody,
      headers: f.json("m-1"),
    });
    expect(minted.status).toBe(201);
    expect(await minted.json()).toMatchObject({ secret: "kbp_secret", replayed: false });
    expect(vi.mocked(keys.mintApiKeyChild).mock.calls[0]?.slice(2)).toEqual([
      resource,
      KB,
      JSON.parse(mintBody),
      "m-1",
    ]);
    vi.mocked(keys.mintApiKeyChild).mockResolvedValueOnce({
      token: { id: TOKEN } as never,
      secret: null,
      replayed: true,
    });
    const replay = await f.call("POST", `/kbs/${KB}/tokens`, {
      body: mintBody,
      headers: f.json("m-1"),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ secret: null, replayed: true });

    expect((await f.call("GET", `/kbs/${KB}/tokens?limit=2`)).status).toBe(200);
    expect(vi.mocked(keys.listApiKeyChildren).mock.calls[0]?.[3]).toEqual({ limit: 2, kbId: KB });
    expect((await f.call("GET", "/tokens")).status).toBe(200);
    expect(vi.mocked(keys.listApiKeyChildren).mock.calls[1]?.[3]).toEqual({});

    const revoked = await f.call("DELETE", `/tokens/${TOKEN}`, {
      headers: { "idempotency-key": "r-1" },
    });
    expect(revoked.status).toBe(200);
    expect(vi.mocked(keys.revokeApiKeyChild).mock.calls[0]?.slice(1)).toEqual([
      { principal: expect.anything(), resource },
      TOKEN,
    ]);
    // Use is recorded after admission on every admitted request.
    expect(keys.touchApiKey).toHaveBeenCalledTimes(10);
  });

  it("refuses delete without the key's allowDelete before any delete work (403)", async () => {
    const f = setup();
    vi.mocked(keys.assertApiKeyMayDelete).mockRejectedValueOnce(
      new KbDomainError("FORBIDDEN", "Forbidden"),
    );
    const response = await f.call("DELETE", `/kbs/${KB}`, {
      body: deleteBody,
      headers: f.json(),
    });
    expect(response.status).toBe(403);
    expect(bases.deleteKnowledgeBase).not.toHaveBeenCalled();
  });

  it("answers unknown paths, methods and malformed ids 404 without domain work", async () => {
    const f = setup();
    for (const [method, path] of [
      ["GET", "/nope"],
      ["PUT", "/kbs"],
      ["GET", "/kbs/NOT-AN-ID"],
      ["GET", "/kbs/short/tokens"],
      ["DELETE", "/tokens/xyz"],
    ] as const) {
      const response = await f.call(method, path, { headers: { "idempotency-key": "k" } });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expectNoDomainCall();
  });
});

describe("REST control plane: request validation", () => {
  const mutations = [
    ["POST", "/kbs", createBody],
    ["DELETE", `/kbs/${KB}`, deleteBody],
    ["POST", `/kbs/${KB}/tokens`, mintBody],
    ["DELETE", `/tokens/${TOKEN}`, undefined],
  ] as const;

  it.each(mutations)(
    "%s %s requires a well-formed Idempotency-Key (400)",
    async (method, path, body) => {
      const f = setup();
      for (const key of [undefined, "", "has space", "x".repeat(129), "semi;colon"]) {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (key !== undefined) headers["idempotency-key"] = key;
        const response = await f.call(method, path, { body, headers });
        expect(response.status, String(key)).toBe(400);
        expect((await errorOf(response)).code).toBe("INVALID_ARGUMENT");
      }
      expectNoDomainCall();
    },
  );

  it("requires application/json bodies (415) and valid JSON (400)", async () => {
    const f = setup();
    for (const type of [undefined, "text/plain", "application/x-www-form-urlencoded"]) {
      const headers: Record<string, string> = { "idempotency-key": "k" };
      if (type) headers["content-type"] = type;
      expect((await f.call("POST", "/kbs", { body: createBody, headers })).status).toBe(415);
    }
    expect(
      (
        await f.call("POST", "/kbs", {
          body: createBody,
          headers: { ...f.json(), "content-type": "application/json; charset=utf-8" },
        })
      ).status,
    ).toBe(201);
    vi.mocked(bases.createKnowledgeBaseAsGrant).mockClear();
    expect((await f.call("POST", "/kbs", { body: "{not json", headers: f.json() })).status).toBe(
      400,
    );
    expect(bases.createKnowledgeBaseAsGrant).not.toHaveBeenCalled();
  });

  it("caps bodies at 16 KiB (413)", async () => {
    const f = setup();
    const big = JSON.stringify({ name: "x", slug: "x", description: "d".repeat(17 * 1024) });
    const response = await f.call("POST", "/kbs", { body: big, headers: f.json() });
    expect(response.status).toBe(413);
    expect((await errorOf(response)).code).toBe("PAYLOAD_TOO_LARGE");
    expectNoDomainCall();
  });

  it("rejects unknown body fields and invalid bodies (400)", async () => {
    const f = setup();
    for (const body of [
      JSON.stringify({ ...JSON.parse(createBody), ownerId: "someone" }),
      JSON.stringify({ name: "x" }),
      JSON.stringify([]),
    ])
      expect((await f.call("POST", "/kbs", { body, headers: f.json() })).status).toBe(400);
    expect(
      (
        await f.call("DELETE", `/kbs/${KB}`, {
          body: JSON.stringify({ metadataVersion: 1, confirm: "yes" }),
          headers: f.json(),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.call("POST", `/kbs/${KB}/tokens`, {
          body: JSON.stringify({ ...JSON.parse(mintBody), allowCreate: true }),
          headers: f.json(),
        })
      ).status,
    ).toBe(400);
    expectNoDomainCall();
  });

  it("rejects unknown or invalid query parameters and a query where none is taken (400)", async () => {
    const f = setup();
    for (const path of [
      "/kbs?limit=0",
      "/kbs?limit=51",
      "/kbs?relation=all",
      "/tokens?kbId=x",
      "/key?verbose=1",
      `/kbs/${KB}?x=1`,
    ])
      expect((await f.call("GET", path)).status, path).toBe(400);
    expectNoDomainCall();
  });

  it("refuses a body on a route that takes none (400)", async () => {
    const f = setup();
    const response = await f.call("DELETE", `/tokens/${TOKEN}`, {
      body: "{}",
      headers: f.json(),
    });
    expect(response.status).toBe(400);
    expect(keys.revokeApiKeyChild).not.toHaveBeenCalled();
  });
});

describe("REST control plane: error mapping", () => {
  it.each([
    [new KbDomainError("NOT_FOUND", "x"), 404, "NOT_FOUND"],
    [new KbAdmissionError("NOT_FOUND", "x"), 404, "NOT_FOUND"],
    [new KbDomainError("FORBIDDEN", "x"), 403, "FORBIDDEN"],
    [new KbAdmissionError("FORBIDDEN", "x"), 403, "FORBIDDEN"],
    [new KbDomainError("CONFLICT", "x"), 409, "CONFLICT"],
    [new KbDomainError("IDEMPOTENCY_MISMATCH", "x"), 409, "IDEMPOTENCY_MISMATCH"],
    [new KbDomainError("QUOTA_EXCEEDED", "x"), 409, "QUOTA_EXCEEDED"],
    [new KbDomainError("INVALID_ARGUMENT", "x"), 400, "INVALID_ARGUMENT"],
    [new KbDomainError("STORAGE_UNAVAILABLE", "x"), 503, "STORAGE_UNAVAILABLE"],
  ] as const)("maps %s to %d", async (error, status, code) => {
    const f = setup();
    vi.mocked(keys.mintApiKeyChild).mockRejectedValueOnce(error);
    const response = await f.call("POST", `/kbs/${KB}/tokens`, {
      body: mintBody,
      headers: f.json(),
    });
    expect(response.status).toBe(status);
    const answer = await errorOf(response);
    expect(answer.code).toBe(code);
    // Never the internal message.
    expect(answer.message).not.toBe("x");
    if (status === 503) expect(response.headers.get("retry-after")).toBe("5");
  });

  it("answers 429 with Retry-After on any route", async () => {
    const f = setup();
    vi.mocked(keys.mintApiKeyChild).mockRejectedValueOnce(
      new KbDomainError("RATE_LIMITED", "x", 17),
    );
    const response = await f.call("POST", `/kbs/${KB}/tokens`, {
      body: mintBody,
      headers: f.json(),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(await errorOf(response)).toEqual({
      code: "RATE_LIMITED",
      message: "Rate limited",
      retryAfterSeconds: 17,
    });
  });

  it("names the live create budget and window on a create over the hourly limit", async () => {
    const f = setup({ setting: "2" });
    vi.mocked(bases.createKnowledgeBaseAsGrant).mockRejectedValueOnce(
      new KbAdmissionError("RATE_LIMITED", "x", 99),
    );
    const response = await f.call("POST", "/kbs", { body: createBody, headers: f.json() });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("99");
    expect(await errorOf(response)).toEqual({
      code: "RATE_LIMITED",
      message: "You can create 2 knowledge bases per 60 minutes. Try again in 99s.",
      retryAfterSeconds: 99,
      limit: 2,
      windowSeconds: 3600,
    });
  });

  it("answers an unexpected failure 500 with a log line and no detail", async () => {
    const f = setup();
    const log = captureLog();
    try {
      vi.mocked(bases.listKnowledgeBases).mockRejectedValueOnce(new Error("private detail"));
      const response = await f.call("GET", "/kbs");
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).not.toContain("private detail");
      expect(JSON.parse(text).error.code).toBe("INTERNAL");
      expect(log.records.length).toBeGreaterThan(0);
    } finally {
      log.restore();
    }
  });
});

describe("REST control plane: OpenAPI", () => {
  it("serves the document without a credential", async () => {
    const f = setup();
    const response = await f.app.request("/api/v1/openapi.json");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(buildOpenApiDocument(origin));
    expect(f.admit).not.toHaveBeenCalled();
  });

  it("documents exactly the routed operations", () => {
    const document = buildOpenApiDocument(origin) as {
      paths: Record<string, Record<string, { operationId: string }>>;
      servers: { url: string }[];
    };
    const documented = Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(([method, op]) => `${method} ${path} ${op.operationId}`),
    );
    expect(documented.sort()).toEqual(
      REST_ROUTES.map((route) => `${route.method} ${route.path} ${route.operationId}`).sort(),
    );
    expect(new Set(REST_ROUTES.map((route) => route.operationId)).size).toBe(REST_ROUTES.length);
    expect(document.servers).toEqual([{ url: `${origin}/api/v1` }]);
  });

  it("matches the checked-in docs/rest-api.openapi.json", async () => {
    await expect(
      `${JSON.stringify(buildOpenApiDocument("https://kb.example.com"), null, 2)}\n`,
    ).toMatchFileSnapshot(resolve(import.meta.dirname, "../../../docs/rest-api.openapi.json"));
  });
});
