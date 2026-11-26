import { describe, expect, it } from "vitest";

import { viewerScopedKey } from "@/lib/viewer-scoped-key";

describe("viewerScopedKey", () => {
  it("gives each viewer its own key under the same oRPC prefix", () => {
    const base = [["documents", "tree"], { input: { kbId: "kb1" }, type: "infinite" }] as const;
    const alice = viewerScopedKey(base, "alice");
    const bob = viewerScopedKey(base, "bob");
    expect(alice).not.toEqual(bob);
    // Prefix invalidation (`.key()`) still reaches both.
    expect(alice.slice(0, base.length)).toEqual([...base]);
    expect(viewerScopedKey(base, null)).toEqual([...base, { viewer: null }]);
  });
});
