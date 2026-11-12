import { describe, expect, it } from "vitest";

import {
  actorKeyForUser,
  canonicalRequestHash,
  OperationIntentError,
  reauthorizeChangesReplay,
  reauthorizeReplay,
} from "./operation-intent";
import type { LiveAuthorityStore } from "./permissions";
import { type KbAdmissionCode, KbAdmissionError } from "./principal";

describe("canonicalRequestHash", () => {
  it("is stable for key order and rejects mismatched bodies", () => {
    const a = canonicalRequestHash({ marker: "x", z: 1 });
    const b = canonicalRequestHash({ z: 1, marker: "x" });
    const c = canonicalRequestHash({ marker: "y", z: 1 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("actorKeyForUser", () => {
  it("uses a non-null user prefix", () => {
    expect(actorKeyForUser("abc")).toBe("user:abc");
  });
});

describe("OperationIntentError", () => {
  it("exposes idempotency mismatch code", () => {
    const error = new OperationIntentError("IDEMPOTENCY_MISMATCH", "body mismatch");
    expect(error.code).toBe("IDEMPOTENCY_MISMATCH");
  });
});

describe("receipt authorization failure kinds", () => {
  const principal = { kind: "browser" as const, userId: "member" };
  const authority: LiveAuthorityStore = {
    loadIdentity: async () => ({ banned: false, twoFactorSatisfied: true, instanceEnabled: true }),
    loadKb: async () => ({ id: "kb", ownerId: "owner", state: "ACTIVE" }),
    loadShare: async () => ({ bits: ["propose"], revokedAt: null }),
  };
  it("replays legitimate propose-only receipts but cannot replay as a writer", async () => {
    await expect(reauthorizeChangesReplay(authority, principal, "kb")).resolves.toBeUndefined();
    await expect(reauthorizeReplay(authority, principal, "kb", "write")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
  it.each([
    "STORAGE_UNAVAILABLE",
    "UNAUTHORIZED",
    "RATE_LIMITED",
    "QUOTA_EXCEEDED",
  ] satisfies KbAdmissionCode[])("preserves %s without attempting weaker replay", async (code) => {
    let calls = 0;
    const failure = new KbAdmissionError(code, "redacted", 2);
    const failed = {
      ...authority,
      loadIdentity: async () => {
        calls++;
        throw failure;
      },
    };
    await expect(reauthorizeReplay(failed, principal, "kb", "write")).rejects.toBe(failure);
    calls = 0;
    await expect(reauthorizeChangesReplay(failed, principal, "kb")).rejects.toBe(failure);
    expect(calls).toBe(1);
  });
  it("denies unreadable receipt replay without trying weaker authority", async () => {
    let calls = 0;
    const revoked = {
      ...authority,
      loadShare: async () => {
        calls++;
        return null;
      },
    };
    await expect(reauthorizeChangesReplay(revoked, principal, "kb")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(calls).toBe(1);
  });
});
