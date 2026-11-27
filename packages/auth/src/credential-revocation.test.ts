vi.mock("@knowledge-base/env/shared", () => ({ env: { DATABASE_POOL_MAX: 10 } }));

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  quarantineUntrustedPasswordWrite,
  revokeCredentialsAfterPasswordChange,
  revokeCredentialsAfterPasswordReset,
} from "./credential-revocation";

const { tx, transaction } = vi.hoisted(() => ({
  tx: {
    $executeRaw: vi.fn(),
    $executeRawUnsafe: vi.fn(),
    deviceCode: { deleteMany: vi.fn() },
    session: { deleteMany: vi.fn() },
    account: { updateMany: vi.fn() },
  },
  transaction: vi.fn(),
}));

vi.mock("@knowledge-base/db", () => ({ default: { $transaction: transaction } }));

beforeEach(() => {
  vi.resetAllMocks();
  tx.$executeRaw.mockResolvedValue(0);
  tx.$executeRawUnsafe.mockResolvedValue(1);
  tx.deviceCode.deleteMany.mockResolvedValue({ count: 1 });
  tx.session.deleteMany.mockResolvedValue({ count: 2 });
  tx.account.updateMany.mockResolvedValue({ count: 1 });
  transaction.mockImplementation(async (run: (client: typeof tx) => Promise<void>) => run(tx));
});

describe("password-reset credential revocation", () => {
  it("retries a failed transaction before returning success", async () => {
    transaction.mockRejectedValueOnce(new Error("lock timeout"));
    await revokeCredentialsAfterPasswordReset("user-1");
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(tx.deviceCode.deleteMany).toHaveBeenCalledOnce();
  });
  it("revokes credentials, bound device logins and all sessions under the same transaction lock", async () => {
    await revokeCredentialsAfterPasswordReset("user-1");
    expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      timeout: 10000,
      maxWait: 5000,
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw.mock.calls[1]![0].join(" ")).toContain("pg_advisory_xact_lock");
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(4);
    const calls = tx.$executeRawUnsafe.mock.calls;
    expect(calls[0]).toEqual([expect.stringContaining('UPDATE "mcp_personal_token"'), "user-1"]);
    expect(calls[1]).toEqual([
      expect.stringContaining('UPDATE "mcp_grant"'),
      "user-1",
      "password_reset",
    ]);
    expect(calls[2]).toEqual([expect.stringContaining('UPDATE "api_key"'), "user-1"]);
    expect(calls[3]).toEqual([expect.stringContaining('FROM "verification" v'), "user-1"]);
    expect(calls[3]?.[0]).toMatch(/\bDELETE\b/);
    const pendingTwoFactorSql = calls[3]![0];
    expect(pendingTwoFactorSql).toContain("WHERE value = $1 AND starts_with(identifier, '2fa-')");
    expect(pendingTwoFactorSql).toContain("v.value = $1 AND (");
    expect(pendingTwoFactorSql).toContain("starts_with(v.identifier, 'trust-device-')");
    expect(pendingTwoFactorSql).toContain("SELECT '2fa-attempts-' || identifier FROM challenges");
    expect(pendingTwoFactorSql).toContain("SELECT '2fa-otp-' || identifier FROM challenges");
    expect(pendingTwoFactorSql).toContain("starts_with(v.identifier, '2fa-otp-' || $1 || '!')");
    expect(tx.deviceCode.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "user-1" },
    });
    expect(tx.session.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "user-1" },
    });
    expect(tx.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
      tx.$executeRawUnsafe.mock.invocationCallOrder[0]!,
    );
    expect(tx.$executeRawUnsafe.mock.invocationCallOrder[2]).toBeLessThan(
      tx.deviceCode.deleteMany.mock.invocationCallOrder[0]!,
    );
    expect(tx.$executeRawUnsafe.mock.invocationCallOrder[3]).toBeLessThan(
      tx.session.deleteMany.mock.invocationCallOrder[0]!,
    );
    expect(tx.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
      tx.session.deleteMany.mock.invocationCallOrder[0]!,
    );
  });

  it("change-password revokes standing credentials under the lock without reset cleanup", async () => {
    await revokeCredentialsAfterPasswordChange({
      userId: "user-1",
      keepSessionToken: "kept-token",
    });
    expect(transaction).toHaveBeenCalledExactlyOnceWith(expect.any(Function), {
      timeout: 10000,
      maxWait: 5000,
    });
    expect(tx.$executeRaw.mock.calls[1]![0].join(" ")).toContain("pg_advisory_xact_lock");
    expect(tx.$executeRawUnsafe.mock.calls).toEqual([
      [expect.stringContaining('UPDATE "mcp_personal_token"'), "user-1"],
      [expect.stringContaining('UPDATE "mcp_grant"'), "user-1", "password_change"],
      [expect.stringContaining('UPDATE "api_key"'), "user-1"],
    ]);
    expect(tx.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
      tx.$executeRawUnsafe.mock.invocationCallOrder[0]!,
    );
    expect(tx.deviceCode.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "user-1" },
    });
    expect(tx.session.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "user-1", token: { not: "kept-token" } },
    });
  });

  it.each(["lock", "tombstones", "device codes", "two-factor", "sessions", "commit"])(
    "propagates a failure at %s",
    async (step) => {
      const error = new Error(`${step} unavailable`);
      if (step === "lock") tx.$executeRaw.mockRejectedValue(error);
      if (step === "tombstones") tx.$executeRawUnsafe.mockRejectedValue(error);
      if (step === "device codes") tx.deviceCode.deleteMany.mockRejectedValue(error);
      if (step === "two-factor")
        tx.$executeRawUnsafe.mockImplementation(async (sql: string) => {
          if (sql.includes('FROM "verification" v')) throw error;
          return 1;
        });
      if (step === "sessions") tx.session.deleteMany.mockRejectedValue(error);
      if (step === "commit") transaction.mockRejectedValue(error);
      await expect(revokeCredentialsAfterPasswordReset("user-1")).rejects.toBe(error);
      expect(transaction).toHaveBeenCalledTimes(3);
    },
  );
});

describe("unconfirmed password write quarantine", () => {
  it("scrambles with the application's hasher under authority before revoking every session/challenge and standing credential", async () => {
    const hash = vi.fn(async () => "unusable-peppered-hash");
    await quarantineUntrustedPasswordWrite("user-1", { hash });
    expect(hash).toHaveBeenCalledExactlyOnceWith(expect.any(String));
    expect(tx.account.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "user-1", providerId: "credential" },
      data: { password: "unusable-peppered-hash" },
    });
    expect(tx.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(
      tx.account.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(tx.account.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.$executeRawUnsafe.mock.invocationCallOrder[0]!,
    );
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('FROM "verification" v'),
      "user-1",
    );
    expect(tx.session.deleteMany).toHaveBeenCalledExactlyOnceWith({ where: { userId: "user-1" } });
    expect(tx.deviceCode.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { userId: "user-1" },
    });
  });
  it("retries and propagates scramble failure before claiming any revocation", async () => {
    const error = new Error("scramble unavailable");
    tx.account.updateMany.mockRejectedValue(error);
    await expect(
      quarantineUntrustedPasswordWrite("user-1", { hash: async () => "unusable-hash" }),
    ).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(3);
    expect(tx.deviceCode.deleteMany).not.toHaveBeenCalled();
    expect(tx.session.deleteMany).not.toHaveBeenCalled();
  });
});
