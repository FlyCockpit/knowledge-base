import { describe, expect, it } from "vitest";

import {
  buildKbAttachment,
  remoteAttachmentLocator,
  sealedNamespaceUuidV5,
  writeModeFor,
} from "./attachment";
import golden from "./fixtures/attachment.json";

describe("attachment identity", () => {
  it("keeps namespace stable when display name changes", () => {
    const origin = "https://kb.example.com";
    const locator = remoteAttachmentLocator(origin, "kb123");
    const first = buildKbAttachment(
      {
        id: "kb123",
        name: "Alpha",
        slug: "alpha",
        description: "ten chars!!",
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        metadataVersion: 1,
        state: "ACTIVE",
        activeGenerationId: "g".repeat(24),
      },
      ["read", "write", "manage"],
      origin,
    );
    const renamed = buildKbAttachment(
      {
        id: "kb123",
        name: "Beta",
        slug: "alpha",
        description: "ten chars!!",
        headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        metadataVersion: 2,
        state: "ACTIVE",
        activeGenerationId: "g".repeat(24),
      },
      ["read", "write", "manage"],
      origin,
    );
    expect(first.embeddingGeneration).toBe("g".repeat(24));
    expect(first.sealedNamespace).toBe(renamed.sealedNamespace);
    expect(first.attachmentLocator).toBe(`${origin}/mcp#kb=kb123`);
    expect(sealedNamespaceUuidV5(locator)).toBe(first.sealedNamespace);
  });

  it("differs across knowledge bases on the same host", () => {
    const origin = "https://kb.example.com";
    const a = sealedNamespaceUuidV5(remoteAttachmentLocator(origin, "kb-a"));
    const b = sealedNamespaceUuidV5(remoteAttachmentLocator(origin, "kb-b"));
    expect(a).not.toBe(b);
  });

  it("matches the shared golden UUIDv5(NAMESPACE_URL) vectors used by kb-client", () => {
    const remote = golden.vectors.filter((v) => v.kind === "remote");
    expect(remote.length).toBeGreaterThanOrEqual(3);
    for (const v of remote) {
      expect(remoteAttachmentLocator(v.origin!, v.kbId)).toBe(v.locator);
      expect(sealedNamespaceUuidV5(v.locator)).toBe(v.namespace);
    }
  });

  it("maps write mode from effective bits", () => {
    expect(writeModeFor(["read"])).toBe("read_only");
    expect(writeModeFor(["read", "propose"])).toBe("proposal_required");
    expect(writeModeFor(["read", "write"])).toBe("direct");
  });
});
