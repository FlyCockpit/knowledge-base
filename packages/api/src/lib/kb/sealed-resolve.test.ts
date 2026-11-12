import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import { remoteSealedNamespace } from "./attachment";
import { chunkBody } from "./chunk";
import { assertSealedReferenceAtRevision, resolvePinnedRevision } from "./documents-read";
import { dreamUpsertToFields } from "./dream";
import vector from "./fixtures/sealed.json";
import type { HeldLockLease, LockQuery } from "./lock";
import type { TokenPrincipal } from "./principal";
import { buildKbSuccessCallToolResult } from "./protocol/envelope";
import { setKbRecoveryComplete } from "./recovery";
import { embedQuery, prepareEmbeddingDocument } from "./redact-for-embed";
import type { KbRuntimeConfig } from "./runtime";
import * as records from "./sealed-records";
import { sealedReference } from "./sealed-reference";
import { resolveSealedReference, type SealedCredentialVerifier } from "./sealed-resolve";

vi.mock("./documents-read", async (original) => ({
  ...(await original<typeof import("./documents-read")>()),
  assertSealedReferenceAtRevision: vi.fn(),
  resolvePinnedRevision: vi.fn(),
}));

function fixture() {
  vi.mocked(assertSealedReferenceAtRevision).mockReset().mockResolvedValue(undefined);
  vi.mocked(resolvePinnedRevision).mockReset().mockResolvedValue("a".repeat(40));
  setKbRecoveryComplete(true);
  const kbId = "a".repeat(24),
    origin = "https://sealed.invalid";
  const namespace = remoteSealedNamespace(origin, kbId);
  const recordId = "00000000-0000-4000-8000-000000000002";
  const reference = sealedReference(namespace, recordId);
  const master = randomBytes(32);
  const literal = records.SecretLiteral.fromUtf8(vector.plaintext);
  const row = {
    version: 1,
    revokedAt: null,
    ciphertext: records.encryptSealedRecord(literal, { namespace, recordId, version: 1 }, master),
    recipientPublicKey: vector.recipientPublicKey,
    expiresAt: new Date(Date.now() + 3600000),
  };
  literal.destroy();
  const state = { record: true, readable: true, live: true, row };
  const query = vi.fn<LockQuery>().mockImplementation(async (sql) => {
    if (sql.includes('FROM "user"'))
      return {
        rows: [{ banned: false, role: "user", twoFactorEnabled: true, createdAt: new Date() }],
        rowCount: 1,
      };
    if (sql.includes('FROM "knowledge_base"'))
      return {
        rows: state.readable
          ? [{ id: kbId, ownerId: "owner", state: "ACTIVE", headSha: "a".repeat(40) }]
          : [],
        rowCount: 1,
      };
    if (sql.includes("sealed_consumer_grant"))
      return { rows: state.record ? [state.row] : [], rowCount: 1 };
    throw new Error(`Unexpected fixture SQL: ${sql}`);
  });
  const lease = mockDeep<HeldLockLease>();
  lease.transaction.mockImplementation((run) => run(query));
  const runtime: Pick<KbRuntimeConfig, "canonicalOrigin" | "reposDir" | "coordinator"> = {
    canonicalOrigin: origin,
    reposDir: "/synthetic",
    coordinator: {
      run: (options) =>
        options.run({
          lease,
          signal: new AbortController().signal,
          issueWriteCapability: () => {
            throw new Error("unused");
          },
        }),
    },
  };
  const principal: TokenPrincipal = {
    kind: "token",
    userId: "owner",
    grantId: "exact-grant",
    grantGeneration: "1",
    scopes: ["mcp:read"],
    expiresAt: new Date(Date.now() + 3600000),
    storedAcl: new Map([[kbId, ["read"]]]),
  };
  const verifier: SealedCredentialVerifier = {
    inspect: vi.fn(async () => ({
      generationActive: state.live,
      expired: false,
      banned: false,
      twoFactorSatisfied: true,
      instanceEnabled: true,
      consumerKind: "pat" as const,
    })),
  };
  const input = {
    kbId,
    path: "sealed.md",
    reference,
    recipientKeyId: vector.result.recipientKeyId,
  };
  const options = { verifier, masterKey: master.toString("base64") };
  return { runtime, principal, input, options, state, query };
}
describe("sealed resolution boundaries", () => {
  it("requires explicit approval even for owner manage and refuses browser identity", async () => {
    const f = fixture();
    f.state.record = false;
    f.principal.storedAcl = new Map([[f.input.kbId, ["manage"]]]);
    await expect(
      resolveSealedReference(f.runtime, f.principal, f.input, f.options),
    ).rejects.toMatchObject({ code: "UNRESOLVED_REFERENCE" });
    await expect(
      resolveSealedReference(f.runtime, { kind: "browser", userId: "owner" }, f.input, f.options),
    ).rejects.toMatchObject({ code: "UNRESOLVED_REFERENCE" });
  });
  it("pins default revision once, uses exact consumer tuple and returns only ciphertext in MCP/text", async () => {
    const f = fixture(),
      before = Date.now();
    const result = await resolveSealedReference(f.runtime, f.principal, f.input, f.options);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(before);
    expect(Date.parse(result.expiresAt)).toBeLessThanOrEqual(Date.now() + 60000);
    expect(assertSealedReferenceAtRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        commitSha: "a".repeat(40),
        path: "sealed.md",
        reference: f.input.reference,
      }),
    );
    expect(resolvePinnedRevision).toHaveBeenCalledTimes(1);
    const grants = f.query.mock.calls.filter(([sql]) => sql.includes("sealed_consumer_grant"));
    expect(grants).toHaveLength(2);
    for (const [, values] of grants)
      expect(values).toEqual([
        f.input.kbId,
        remoteSealedNamespace(f.runtime.canonicalOrigin, f.input.kbId),
        "00000000-0000-4000-8000-000000000002",
        "exact-grant",
        f.input.recipientKeyId,
        // The resolving user must be sealed-eligible (owner or opted-in share).
        f.principal.userId,
      ]);
    for (const [sql] of grants) {
      expect(sql).toContain(`g."consumerKind"='pat'`);
      expect(sql).toContain(`es."includeSealedValues"`);
    }
    const transport = buildKbSuccessCallToolResult(result);
    expect(JSON.parse(transport.content[0].text).data).toEqual(result);
    expect(JSON.stringify([transport, f.query.mock.calls])).not.toContain(vector.plaintext);
  });
  it("rechecks record, current read, credential and expiry at final-read barrier before decryption", async () => {
    for (const revoke of [
      (f: ReturnType<typeof fixture>) => {
        f.state.record = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.readable = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.live = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.state.row.expiresAt = new Date(0);
      },
    ]) {
      const f = fixture();
      const decrypt = vi.spyOn(records, "decryptSealedRecord");
      try {
        await expect(
          resolveSealedReference(f.runtime, f.principal, f.input, {
            ...f.options,
            beforeFinalRead: async () => revoke(f),
          }),
        ).rejects.toMatchObject({ code: "UNRESOLVED_REFERENCE" });
        expect(decrypt).not.toHaveBeenCalled();
      } finally {
        decrypt.mockRestore();
      }
    }
  });
  it("suppresses cancelled replies and zeroizes plaintext on success and wrapping failure", async () => {
    for (const corruptKey of [false, true]) {
      const f = fixture();
      if (corruptKey) f.state.row.recipientPublicKey = Buffer.alloc(32).toString("base64");
      const decrypt = records.decryptSealedRecord;
      let borrowed: Buffer | undefined;
      const spy = vi.spyOn(records, "decryptSealedRecord").mockImplementation((...args) => {
        const value = decrypt(...args);
        value.use((bytes) => {
          borrowed = bytes;
        });
        return value;
      });
      try {
        const result = resolveSealedReference(f.runtime, f.principal, f.input, f.options);
        if (corruptKey)
          await expect(result).rejects.toMatchObject({ code: "UNRESOLVED_REFERENCE" });
        else await result;
        expect(borrowed?.every((byte) => byte === 0)).toBe(true);
      } finally {
        spy.mockRestore();
      }
    }
    const f = fixture(),
      abort = new AbortController();
    await expect(
      resolveSealedReference(f.runtime, f.principal, f.input, {
        ...f.options,
        signal: abort.signal,
        beforeFinalRead: async () => abort.abort(),
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
  it("captures symbolic search/index/dream/provider payloads with no decrypted canary", async () => {
    const f = fixture();
    await resolveSealedReference(f.runtime, f.principal, f.input, f.options);
    const source = `Public words ${f.input.reference}`;
    const chunks = chunkBody(source);
    const embed = vi.fn(async () => [[1]]);
    await embedQuery({ embed }, source);
    const provider = chunks.chunks.map((c) => prepareEmbeddingDocument(c.text));
    const dream = dreamUpsertToFields({
      id: "example",
      type: "concept",
      title: null,
      body: source,
      citations: [],
      provenance: "dream",
    });
    expect(chunks.chunks[0]?.text).toContain("[sealed value redacted]");
    expect(JSON.stringify([chunks, embed.mock.calls, provider, dream])).not.toContain(
      vector.plaintext,
    );
    expect(JSON.stringify(dream)).toContain(f.input.reference);
  });
});
