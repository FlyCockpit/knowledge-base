import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/db", () => ({ default: {} }));
const revoke = vi.hoisted(() => vi.fn(async (_tx: unknown, _userId: string) => {}));
vi.mock("./credential-revocation.js", () => ({ revokeCredentialsInTransaction: revoke }));
const { clearPendingInvitePassword } = await import("./sso-invite-activation.js");

beforeEach(() => vi.clearAllMocks());

describe("pending SSO activation decision on the caller's transaction", () => {
  it.each([{ accounts: [] }, { accounts: [{ providerId: "credential" }] }])(
    "clears a pending KB invite with $accounts accounts before revocation",
    async ({ accounts }) => {
      const tx = {
        user: { findUnique: vi.fn(async () => ({ emailVerified: false, accounts, sessions: [] })) },
        account: { updateMany: vi.fn(async () => ({ count: accounts.length })) },
      };
      expect(await clearPendingInvitePassword(tx as never, "invitee")).toBe(true);
      expect(tx.account.updateMany).toHaveBeenCalledExactlyOnceWith({
        where: { userId: "invitee", providerId: "credential" },
        data: { password: null },
      });
      expect(revoke).toHaveBeenCalledExactlyOnceWith(tx, "invitee");
      expect(tx.account.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
        revoke.mock.invocationCallOrder[0]!,
      );
    },
  );

  it.each([
    null,
    { emailVerified: true, accounts: [{ providerId: "credential" }], sessions: [] },
    { emailVerified: false, accounts: [{ providerId: "sso" }], sessions: [] },
    {
      emailVerified: false,
      accounts: [{ providerId: "credential" }, { providerId: "credential" }],
      sessions: [],
    },
    { emailVerified: false, accounts: [], sessions: [{ id: "live" }] },
  ])("preserves an existing active/missing identity: %j", async (state) => {
    const tx = {
      user: { findUnique: vi.fn(async () => state) },
      account: { updateMany: vi.fn() },
    };
    expect(await clearPendingInvitePassword(tx as never, "invitee")).toBe(false);
    expect(tx.account.updateMany).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });
});
