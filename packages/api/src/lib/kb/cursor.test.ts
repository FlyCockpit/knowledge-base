import { describe, expect, it } from "vitest";

import { createCursorSigner, cursorExpiry, stableFilterHash } from "./cursor";
import { KbDomainError } from "./errors";

const secret = Buffer.alloc(32, 7);

describe("kb list cursor", () => {
  const signer = createCursorSigner(secret);

  it("rejects foreign actor, filter, kb, revision, and expiry", () => {
    const token = signer.sign({
      v: 1,
      actorKey: "user:a",
      kbId: "kb1",
      filterHash: stableFilterHash({}),
      sortKey: "path:asc",
      revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      lastKey: "docs/a.md",
      exp: cursorExpiry(),
    });
    expect(() =>
      signer.verify(token, {
        actorKey: "user:b",
        kbId: "kb1",
        filterHash: stableFilterHash({}),
        sortKey: "path:asc",
        revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toThrow(KbDomainError);
    expect(() =>
      signer.verify(token, {
        actorKey: "user:a",
        kbId: "kb2",
        filterHash: stableFilterHash({}),
        sortKey: "path:asc",
        revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toThrow(KbDomainError);
    const expired = signer.sign({
      v: 1,
      actorKey: "user:a",
      kbId: "kb1",
      filterHash: stableFilterHash({}),
      sortKey: "path:asc",
      revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      lastKey: null,
      exp: Date.now() - 1,
    });
    expect(() =>
      signer.verify(expired, {
        actorKey: "user:a",
        kbId: "kb1",
        filterHash: stableFilterHash({}),
        sortKey: "path:asc",
        revision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toThrow(KbDomainError);
  });
});
