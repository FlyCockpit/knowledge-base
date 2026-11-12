import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildKbAttachment, remoteSealedNamespace } from "./attachment";
import { KB_MANAGED_GITIGNORE } from "./paths";
import { parseSealedReference, sealedReference, sealedTreeValidator } from "./sealed-reference";
import { stageCommitWithTreeFiles } from "./staged-tree";
import { validateStagedCommitTree } from "./validate-tree";

const namespace = randomUUID(),
  recordId = randomUUID();
const reference = `{{sealed:v1:knowledge_base:${namespace}:${recordId}}}`;
describe("sealed reference grammar and full-tree boundary", () => {
  it("accepts only canonical fully delimited knowledge-base UUID symbols", () => {
    expect(sealedReference(namespace, recordId)).toBe(reference);
    expect(parseSealedReference(reference)).toEqual({ namespace, recordId });
    for (const bad of [
      reference.toUpperCase(),
      reference.slice(2, -2),
      `${reference}x`,
      reference.replace("v1", "v2"),
      reference.replace(recordId, "*"),
      reference.replace(recordId, "-".repeat(36)),
    ])
      expect(() => parseSealedReference(bad)).toThrow();
  });
  it("separates same-host KBs, keeps identity across display renames, and changes on reattachment", () => {
    const row = {
      id: "a".repeat(24),
      name: "First",
      slug: "first",
      description: "Fixture description",
      metadataVersion: 1,
      headSha: "a".repeat(40),
      state: "ACTIVE",
      activeGenerationId: null,
    };
    const a = buildKbAttachment(row, ["read"], "https://example.invalid");
    expect(a.sealedNamespace).toBe(remoteSealedNamespace("https://example.invalid", row.id));
    expect(
      buildKbAttachment({ ...row, name: "Renamed" }, ["read"], "https://example.invalid")
        .sealedNamespace,
    ).toBe(a.sealedNamespace);
    expect(remoteSealedNamespace("https://example.invalid", "b".repeat(24))).not.toBe(
      a.sealedNamespace,
    );
    expect(remoteSealedNamespace("https://new.invalid", row.id)).not.toBe(a.sealedNamespace);
  });
  it("validates every document, including decoded YAML, and fails closed without authority", () => {
    const validate = (body: string, live = new Set([recordId]), authority = true) => {
      const staged = stageCommitWithTreeFiles({
        parentSha: "a".repeat(40),
        message: "fixture",
        files: Object.entries({
          ".gitignore": KB_MANAGED_GITIGNORE,
          ".assets/manifest.json": '{"version":1,"entries":[]}\n',
          "index.md": "ordinary",
          "nested/secret.md": body,
        }).map(([path, content]) => ({ segments: path.split("/"), content: Buffer.from(content) })),
      });
      return validateStagedCommitTree(staged, {
        ...(authority ? { validateSealedReferences: sealedTreeValidator(namespace, live) } : {}),
      });
    };
    expect(validate("ordinary").ok).toBe(true);
    expect(validate(reference).ok).toBe(true);
    expect(validate("ordinary", new Set(), false).ok).toBe(true);
    expect(validate(reference, new Set([recordId]), false)).toMatchObject({
      ok: false,
      code: "TREE_SEALED",
    });
    expect(validate(reference, new Set())).toMatchObject({ ok: false, code: "TREE_SEALED" });
    expect(validate(reference.replace(namespace, randomUUID()))).toMatchObject({
      ok: false,
      code: "TREE_SEALED",
    });
    expect(
      validate(`---\nvalue: "${reference.replace("sealed", "\\u0073ealed")} "\n---\n`, new Set()),
    ).toMatchObject({ ok: false, code: "TREE_SEALED" });
    expect(sealedTreeValidator(namespace, new Set())([])).toBeNull();
  });
  it("L-8: a retained revoked reference in an unchanged blob never blocks other writes", () => {
    const blobSha = (text: string) =>
      createHash("sha1")
        .update(
          Buffer.concat([Buffer.from(`blob ${Buffer.byteLength(text)}\0`), Buffer.from(text)]),
        )
        .digest("hex");
    const staged = (secret: string) =>
      stageCommitWithTreeFiles({
        parentSha: "a".repeat(40),
        message: "fixture",
        files: Object.entries({
          ".gitignore": KB_MANAGED_GITIGNORE,
          ".assets/manifest.json": '{"version":1,"entries":[]}\n',
          "index.md": "an unrelated edit",
          "db.md": secret,
        }).map(([path, content]) => ({ segments: path.split("/"), content: Buffer.from(content) })),
      });
    const revoked = sealedTreeValidator(namespace, new Set());
    const body = `password: ${reference}`;
    // db.md is byte-identical to the base: the revoked reference is retained.
    expect(
      validateStagedCommitTree(staged(body), {
        validateSealedReferences: revoked,
        baseBlobs: new Map([["db.md", blobSha(body)]]),
      }).ok,
    ).toBe(true);
    // Changing db.md (or adding the reference anywhere) needs a live record.
    expect(
      validateStagedCommitTree(staged(`${body}\nmore`), {
        validateSealedReferences: revoked,
        baseBlobs: new Map([["db.md", blobSha(body)]]),
      }),
    ).toMatchObject({ ok: false, code: "TREE_SEALED", path: "db.md" });
    expect(
      validateStagedCommitTree(staged(body), { validateSealedReferences: revoked }),
    ).toMatchObject({ ok: false, code: "TREE_SEALED" });
  });
});
