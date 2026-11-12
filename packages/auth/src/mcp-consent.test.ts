import { createHmac } from "node:crypto";
import type { Prisma } from "@knowledge-base/db/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertLiveConsentSelection,
  type ConsentSelection,
  consentSelection,
  createMcpConsentService,
  credentialSelection,
  isConsentSubset,
  McpConsentError,
  McpSealedConsentError,
  verifyOAuthQuery,
} from "./mcp-consent";
import { deriveMcpConsentReferenceId } from "./mcp-grant";

const secret = "consent-unit-fixture-secret";
const resource = "https://kb.example.invalid/mcp";
const now = new Date("2026-09-26T00:00:00Z");
function signed(changes: Record<string, string> = {}) {
  const p = new URLSearchParams({
    client_id: "client",
    redirect_uri: "https://client.invalid/cb",
    resource,
    scope: "mcp:read offline_access",
    response_type: "code",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    exp: String(now.getTime() / 1000 + 600),
    ...changes,
  });
  const canonical = new URLSearchParams(
    [...p].sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0)),
  );
  p.set("sig", createHmac("sha256", secret).update(canonical.toString()).digest("base64"));
  return p.toString();
}

describe("consent signed provider transaction", () => {
  it("accepts the provider HMAC wire format and binds a canonical digest", () => {
    const value = verifyOAuthQuery(signed(), secret, resource, now);
    expect(value).toMatchObject({
      clientId: "client",
      resource,
      scopes: ["mcp:read", "offline_access"],
    });
    expect(
      verifyOAuthQuery(
        new URLSearchParams([...new URLSearchParams(signed())].reverse()).toString(),
        secret,
        resource,
        now,
      ).queryDigest,
    ).toBe(value.queryDigest);
  });
  it.each(["client_id", "redirect_uri", "resource", "scope", "exp"])(
    "rejects signed %s tampering",
    (key) => {
      const p = new URLSearchParams(signed());
      p.set(key, "forged");
      expect(() => verifyOAuthQuery(p.toString(), secret, resource, now)).toThrow();
    },
  );
  it("rejects expired/wrong-resource/duplicate/unsigned/unsupported transactions", () => {
    for (const query of [
      signed({ exp: "1" }),
      signed({ resource: "https://other.invalid/mcp" }),
      `${signed()}&client_id=client`,
      `${signed()}&sig=bad`,
      "client_id=client",
      signed({ scope: "openid" }),
      signed({ code_challenge_method: "plain" }),
    ]) {
      expect(() => verifyOAuthQuery(query, secret, resource, now)).toThrow();
    }
  });
  it("requires a consent nonce in the session/client HMAC", () => {
    const input = { secret, sessionId: "session", clientId: "client", nonce: "nonce-a" };
    const ref = deriveMcpConsentReferenceId(input);
    expect(ref).toHaveLength(64);
    for (const change of [{ nonce: "nonce-b" }, { sessionId: "other" }, { clientId: "other" }])
      expect(deriveMcpConsentReferenceId({ ...input, ...change })).not.toBe(ref);
    expect(() => deriveMcpConsentReferenceId({ ...input, nonce: "" })).toThrow();
  });
});

describe("consent ceilings", () => {
  const base = consentSelection.parse({
    scopes: ["mcp:read", "mcp:write", "offline_access"],
    toolGroups: ["read", "edit", "kb_admin"],
    acl: [{ kbId: "a".repeat(24), bits: ["read", "propose"] }],
    allowCreate: true,
    createdKbBits: ["read"],
  });
  it("supports explicit empty ACL and no default capabilities", () => {
    expect(
      consentSelection.parse({ scopes: ["mcp:read"], toolGroups: ["read"], acl: [] }),
    ).toMatchObject({
      acl: [],
      allowCreate: false,
      createdKbBits: [],
    });
    expect(consentSelection.safeParse({ scopes: ["mcp:read"] }).success).toBe(false);
    // Every grant names its tool groups: none, empty and unknown sets are refused,
    // and OAuth (which never resolves sealed values) cannot hold `sealed`.
    expect(consentSelection.safeParse({ scopes: ["mcp:read"], acl: [] }).success).toBe(false);
    for (const toolGroups of [[], ["admin"], ["read", "read"], ["read", "sealed"]])
      expect(
        consentSelection.safeParse({ scopes: ["mcp:read"], toolGroups, acl: [] }).success,
      ).toBe(false);
    expect(
      isConsentSubset(
        consentSelection.parse({ scopes: ["mcp:read"], toolGroups: ["read"], acl: [] }),
        base,
      ),
    ).toBe(true);
  });
  it("permits narrowing, rejects each kind of expansion", () => {
    const narrow = consentSelection.parse({
      scopes: ["mcp:read"],
      toolGroups: ["read"],
      acl: [{ kbId: "a".repeat(24), bits: ["read"] }],
    });
    expect(isConsentSubset(narrow, base)).toBe(true);
    for (const selection of [
      { ...narrow, scopes: ["mcp:write"] },
      { ...narrow, toolGroups: ["read", "assets"] },
      { ...narrow, toolGroups: [] },
      { ...narrow, acl: [...narrow.acl, { kbId: "b".repeat(24), bits: ["read"] }] },
      { ...narrow, acl: [{ kbId: "a".repeat(24), bits: ["write"] }] },
      { ...narrow, allowCreate: true, createdKbBits: ["read"] },
      { ...base, createdKbBits: ["read", "write"] },
    ])
      expect(
        isConsentSubset(
          selection,
          selection === base ? narrow : selection.createdKbBits.includes("write") ? base : narrow,
        ),
      ).toBe(false);
  });
  it("requires kb_admin for creation in every credential and consent selection", async () => {
    const selection: ConsentSelection = {
      scopes: ["mcp:read", "mcp:write"],
      toolGroups: ["read"],
      acl: [],
      allowCreate: true,
      createdKbBits: ["read"],
    };
    for (const schema of [credentialSelection, consentSelection]) {
      expect(schema.safeParse(selection).success).toBe(false);
      expect(schema.parse({ ...selection, toolGroups: ["read", "kb_admin"] })).toMatchObject({
        allowCreate: true,
        createdKbBits: ["read"],
      });
    }
    const transaction = vi.fn();
    const db = { $transaction: transaction } as never;
    await expect(
      createMcpConsentService({ db, secret, resource, now: () => now }).approve(
        { userId: "user", sessionId: "session" },
        {
          referenceId: "a".repeat(64),
          nonce: "cfd00cbf-feb7-4dcd-81db-69938c394d75",
          oauthQuery: signed({ scope: "mcp:read mcp:write" }),
          explicitConsent: true,
          selection,
        },
      ),
    ).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
  it("OAuth consent rejects a requested sealed recipient capability with a typed error before any DB work", async () => {
    const recipient = {
      kbId: "a".repeat(24),
      namespace: "cfd00cbf-feb7-4dcd-81db-69938c394d75",
      recordId: "bf9d9446-ef55-4d5b-8f4f-c4f6351b1111",
      recipientKeyId: "3a2aa717-f797-4b54-8be2-b7d161910444",
      recipientPublicKey: Buffer.alloc(32, 7).toString("base64"),
      expiresAt: "2026-09-27T00:00:00.000Z",
    };
    // The normalized OAuth selection has no place for recipients at all.
    expect(
      consentSelection.safeParse({
        scopes: ["mcp:read"],
        toolGroups: ["read"],
        acl: [],
        recipients: [recipient],
      }).success,
    ).toBe(false);
    const touched: string[] = [];
    const db = new Proxy(
      {},
      {
        get(_t, key) {
          touched.push(String(key));
          throw new Error("db must not be touched");
        },
      },
    ) as never;
    const service = createMcpConsentService({ db, secret: "s", resource: "https://r.invalid/mcp" });
    const base = {
      referenceId: "a".repeat(64),
      nonce: "cfd00cbf-feb7-4dcd-81db-69938c394d75",
      oauthQuery: "x=1",
      explicitConsent: true,
    };
    for (const recipients of [[recipient], [{ anything: true }]]) {
      const error = await service
        .approve(
          { userId: "u", sessionId: "s" },
          {
            ...base,
            selection: { scopes: ["mcp:read"], toolGroups: ["read"], acl: [], recipients },
          },
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(McpSealedConsentError);
      expect(error).toBeInstanceOf(McpConsentError);
      expect(error).toMatchObject({
        code: "SEALED_VALUES_REQUIRE_CLI_OR_PAT",
        message: "Sealed values require the CLI or a personal access token.",
      });
    }
    expect(touched).toEqual([]);
    // An empty list asks for nothing sealed: it gets past the sealed check.
    const error = await service
      .approve(
        { userId: "u", sessionId: "s" },
        {
          ...base,
          selection: {
            scopes: ["mcp:read"],
            toolGroups: ["read"],
            acl: [],
            recipients: [],
          },
        },
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).not.toBeInstanceOf(McpSealedConsentError);
  });
  it("the device (PAT) selection may hold the sealed group", () => {
    expect(
      credentialSelection.parse({ scopes: ["mcp:read"], toolGroups: ["sealed", "read"], acl: [] })
        .toolGroups,
    ).toEqual(["read", "sealed"]);
  });
  it("the device (PAT) selection still carries exact recipients", () => {
    const recipient = {
      kbId: "a".repeat(24),
      namespace: "cfd00cbf-feb7-4dcd-81db-69938c394d75",
      recordId: "bf9d9446-ef55-4d5b-8f4f-c4f6351b1111",
      recipientKeyId: "3a2aa717-f797-4b54-8be2-b7d161910444",
      recipientPublicKey: Buffer.alloc(32, 7).toString("base64"),
      expiresAt: "2026-09-27T00:00:00.000Z",
    };
    expect(
      credentialSelection.parse({
        scopes: ["mcp:read"],
        toolGroups: ["read"],
        acl: [],
        recipients: [recipient],
      }).recipients,
    ).toEqual([recipient]);
  });
});

describe("live consent ACL batching", () => {
  const knowledgeBase = { findMany: vi.fn() };
  const kbShare = { findMany: vi.fn() };
  const tx = { knowledgeBase, kbShare } as unknown as Prisma.TransactionClient;
  const kbId = "a".repeat(24);
  const selection = consentSelection.parse({
    scopes: ["mcp:read"],
    toolGroups: ["read"],
    acl: [{ kbId, bits: ["read"] }],
    allowCreate: false,
    createdKbBits: [],
  });
  beforeEach(() => {
    vi.clearAllMocks();
    knowledgeBase.findMany.mockResolvedValue([{ id: kbId, ownerId: "other", state: "ACTIVE" }]);
    kbShare.findMany.mockResolvedValue([]);
  });

  it("allows owned KBs even with a revoked share", async () => {
    knowledgeBase.findMany.mockResolvedValue([{ id: kbId, ownerId: "user", state: "ACTIVE" }]);
    kbShare.findMany.mockResolvedValue([{ kbId, bits: [], revokedAt: now }]);
    await expect(assertLiveConsentSelection(tx, "user", selection, now)).resolves.toBeUndefined();
  });

  it("expands live shared bits before checking the selection", async () => {
    kbShare.findMany.mockResolvedValue([{ kbId, bits: ["write"], revokedAt: null }]);
    await expect(assertLiveConsentSelection(tx, "user", selection, now)).resolves.toBeUndefined();
  });

  it.each(["revoked", "missing share", "insufficient bits", "missing KB", "inactive KB"])(
    "rejects %s with the same consent error",
    async (condition) => {
      kbShare.findMany.mockResolvedValue([
        { kbId, bits: ["read"], revokedAt: condition === "revoked" ? now : null },
      ]);
      if (condition === "missing share") kbShare.findMany.mockResolvedValue([]);
      if (condition === "insufficient bits")
        kbShare.findMany.mockResolvedValue([{ kbId, bits: [], revokedAt: null }]);
      if (condition === "missing KB") knowledgeBase.findMany.mockResolvedValue([]);
      if (condition === "inactive KB")
        knowledgeBase.findMany.mockResolvedValue([
          { id: kbId, ownerId: "user", state: "ARCHIVED" },
        ]);
      await expect(assertLiveConsentSelection(tx, "user", selection, now)).rejects.toThrow(
        new McpConsentError(),
      );
    },
  );

  it("deduplicates query IDs while checking every entry in original order", async () => {
    kbShare.findMany.mockResolvedValue([{ kbId, bits: ["read"], revokedAt: null }]);
    await expect(
      assertLiveConsentSelection(
        tx,
        "user",
        { ...selection, acl: [...selection.acl, { kbId, bits: ["write"] }] },
        now,
      ),
    ).rejects.toThrow(McpConsentError);
    expect(knowledgeBase.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: { in: [kbId] } },
      select: { id: true, ownerId: true, state: true },
    });
    expect(kbShare.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "user", kbId: { in: [kbId] } },
      select: { kbId: true, bits: true, revokedAt: true },
    });
  });
});
