import type prisma from "@knowledge-base/db";
import type { Prisma } from "@knowledge-base/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPasswordPepper } from "./password-pepper";
import {
  PasswordPepperKeyError,
  resetUnusablePasswords,
  syncPasswordPepper,
} from "./password-pepper-store";

vi.mock("@knowledge-base/db", () => ({ default: {} }));

const old = createPasswordPepper({ secret: "disposable-old-unit-test-key-0123456789" });
const current = createPasswordPepper({ secret: "disposable-new-unit-test-key-9876543210" });
const rotating = createPasswordPepper({
  secret: "disposable-new-unit-test-key-9876543210",
  previousSecret: "disposable-old-unit-test-key-0123456789",
});
// Valid Better-Auth shape; conversion does no scrypt and needs no plaintext.
const legacy = `${"01".repeat(16)}:${"23".repeat(64)}`;
type Row = { id: string; userId: string; password: string | null };
type InputRow = Omit<Row, "userId"> & { userId?: string };
const log = { info: vi.fn(), warn: vi.fn() };

function database(initial: InputRow[], racedId?: string, racedValue = "concurrently-changed") {
  const db = { $transaction: vi.fn<typeof prisma.$transaction>() };
  const tx = {
    $executeRaw: vi.fn<(sql: TemplateStringsArray, ...values: unknown[]) => Promise<number>>(),
    account: {
      findMany: vi.fn<(args: Prisma.AccountFindManyArgs) => Promise<Row[]>>(),
      count: vi.fn<(args: Prisma.AccountCountArgs) => Promise<number>>(),
      updateMany: vi.fn<(args: Prisma.AccountUpdateManyArgs) => Promise<{ count: number }>>(),
    },
  };
  const committed = initial.map((row) => ({ ...row, userId: row.userId ?? `user-${row.id}` }));
  let rows = committed.map((row) => ({ ...row }));
  tx.$executeRaw.mockResolvedValue(1);
  tx.account.findMany.mockImplementation(async (args) => {
    const where = args?.where;
    const after = typeof where?.id === "object" ? where.id.gt : undefined;
    return rows
      .filter((row) => row.password !== null && !(typeof after === "string" && row.id <= after))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, args?.take ?? 0);
  });
  tx.account.count.mockImplementation(async (args) => {
    const password = args.where?.password;
    const prefix =
      typeof password === "object" && password !== null ? password.startsWith : undefined;
    return rows.filter((row) => typeof prefix === "string" && row.password?.startsWith(prefix))
      .length;
  });
  tx.account.updateMany.mockImplementation(async (args) => {
    const row = rows.find((row) => row.id === args.where?.id);
    if (row && row.id === racedId) row.password = racedValue;
    if (!row || row.password !== args.where?.password) return { count: 0 };
    if (typeof args.data.password !== "string") throw new Error("expected string password update");
    row.password = args.data.password;
    return { count: 1 };
  });
  db.$transaction.mockImplementation(async (fn) => {
    if (typeof fn !== "function") throw new Error("expected interactive transaction");
    rows = committed.map((row) => ({ ...row }));
    // This fixture implements only the three transaction methods under test.
    const result = await fn(tx as unknown as Prisma.TransactionClient);
    committed.splice(0, committed.length, ...rows);
    return result;
  });
  // Vitest retains only Prisma's last overload (interactive transactions).
  return { db: db as unknown as Pick<typeof prisma, "$transaction">, tx, rows: committed };
}

beforeEach(() => vi.clearAllMocks());

describe("syncPasswordPepper", () => {
  it("emits structured success and refusal events without exposing stored values", async () => {
    const events = vi.fn();
    const good = database([{ id: "a", password: legacy }]);
    await syncPasswordPepper(good.db, current, log, events);
    expect(events.mock.calls.map(([event]) => event)).toEqual([
      { event: "sealed", count: 1, fingerprint: current.fingerprint },
      { event: "ok", fingerprint: current.fingerprint },
    ]);
    events.mockClear();
    const bad = database([{ id: "a", password: await old.hash("unit-test-password") }]);
    await expect(syncPasswordPepper(bad.db, current, log, events)).rejects.toBeInstanceOf(
      PasswordPepperKeyError,
    );
    expect(events).toHaveBeenCalledWith({
      event: "key-refused",
      fingerprint: current.fingerprint,
      unknownFingerprint: old.fingerprint,
      count: 1,
      docs: "docs/hosting.md § Password pepper",
    });
  });

  it("seals legacy, re-wraps previous, leaves current, and counts corrupt values", async () => {
    const previous = await old.hash("unit-test-password-123");
    const sealed = await current.hash("unit-test-password-456");
    const { db, tx, rows } = database([
      { id: "a", password: legacy },
      { id: "b", password: previous },
      { id: "c", password: sealed },
      { id: "d", password: "malformed" },
      { id: "e", password: `pw1:${old.fingerprint}:invalid` },
      { id: "f", password: null },
    ]);
    await expect(syncPasswordPepper(db, rotating, log)).resolves.toEqual({
      fingerprint: current.fingerprint,
      sealed: 1,
      resealed: 1,
      malformed: 1,
      corrupt: 1,
      remainingPrevious: 1,
    });
    expect(
      rows.slice(0, 3).every((row) => current.classify(row.password ?? "") === "current"),
    ).toBe(true);
    expect(rows[2]?.password).toBe(sealed);
    expect(tx.account.updateMany).toHaveBeenCalledWith({
      where: { id: "a", password: legacy },
      data: { password: rows[0]?.password },
    });
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.account.findMany.mock.invocationCallOrder[0] ?? 0,
    );
    expect(tx.$executeRaw.mock.calls[0]?.[0].join("?")).toContain(
      "pg_advisory_xact_lock(hashtext(?))",
    );
    expect(tx.$executeRaw.mock.calls[0]?.[1]).toBe("password-pepper");
    expect(log.info).toHaveBeenCalledWith(`password pepper: ok (key fp ${current.fingerprint})`);
    expect(log.info).not.toHaveBeenCalledWith(expect.stringMatching(/can now be removed/));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("1 password hash(es) are still under previous key"),
    );
    expect(tx.account.count.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.account.updateMany.mock.invocationCallOrder.at(-1) ?? 0,
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("2 stored password value(s)"));
  });

  it("does not claim completion with a corrupt previous row, then refuses without the previous key", async () => {
    const { db } = database([{ id: "a", password: `pw1:${old.fingerprint}:!` }]);
    const result = await syncPasswordPepper(db, rotating, log);
    expect(result).toMatchObject({ corrupt: 1, remainingPrevious: 1 });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("keep BETTER_AUTH_SECRET_PREVIOUS set and restart again"),
    );
    expect(log.info).not.toHaveBeenCalledWith(expect.stringMatching(/can now be removed/));
    log.info.mockClear();
    await expect(syncPasswordPepper(db, current, log)).rejects.toBeInstanceOf(
      PasswordPepperKeyError,
    );
    expect(log.info).not.toHaveBeenCalled();
  });

  it("counts a concurrent replacement with another valid previous-key hash", async () => {
    const first = old.reseal(legacy) ?? "";
    const replacement = old.reseal(legacy) ?? "";
    const { db, rows } = database([{ id: "a", password: first }], "a", replacement);
    const result = await syncPasswordPepper(db, rotating, log);
    expect(result).toMatchObject({ resealed: 0, remainingPrevious: 1 });
    expect(rows[0]?.password).toBe(replacement);
    expect(rotating.isAuthentic(replacement)).toBe(true);
    expect(log.info).not.toHaveBeenCalledWith(expect.stringMatching(/can now be removed/));
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("1 password hash(es) are still under previous key"),
    );
  });

  it("validates all current-key values, warns on corrupt envelopes, and still starts", async () => {
    const valid = current.reseal(legacy) ?? "";
    const parts = valid.split(":");
    const bytes = Buffer.from(parts[2] ?? "", "base64url");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    const values = [
      `pw1:${current.fingerprint}:!`,
      valid.slice(0, -12),
      `${valid}:extra`,
      `pw1:${current.fingerprint}:${bytes.toString("base64url")}`,
    ];
    const { db, tx, rows } = database(values.map((password, i) => ({ id: String(i), password })));
    await expect(syncPasswordPepper(db, current, log)).resolves.toMatchObject({
      corrupt: 4,
      malformed: 0,
    });
    expect(rows.map((row) => row.password)).toEqual(values);
    expect(tx.account.updateMany).not.toHaveBeenCalled();
    expect(tx.account.findMany.mock.calls[0]?.[0].where).not.toHaveProperty("NOT");
    expect(log.warn).toHaveBeenCalledWith(
      "password pepper: 4 stored password value(s) are corrupt or not a password hash and can never sign in; run `pnpm auth:pepper:reset-unusable` (docs/hosting.md § Password pepper)",
    );
    expect(log.info).toHaveBeenCalledWith(`password pepper: ok (key fp ${current.fingerprint})`);
  });

  it("pages past 500 converted rows with an id keyset", async () => {
    const { db, tx, rows } = database(
      Array.from({ length: 1001 }, (_, i) => ({
        id: String(i).padStart(4, "0"),
        password: legacy,
      })),
    );
    const result = await syncPasswordPepper(db, current, log);
    expect(result.sealed).toBe(1001);
    expect(tx.account.findMany).toHaveBeenCalledTimes(3);
    expect(tx.account.findMany.mock.calls.map(([args]) => args?.where?.id)).toEqual([
      undefined,
      { gt: "0499" },
      { gt: "0999" },
    ]);
    expect(
      tx.account.findMany.mock.calls.every(
        ([args]) => args?.take === 500 && args.orderBy && !args.skip,
      ),
    ).toBe(true);
    expect(rows.every((row) => current.classify(row.password ?? "") === "current")).toBe(true);
    expect(log.info.mock.calls.some(([line]) => /re-wrapped|can now be removed/.test(line))).toBe(
      false,
    );
  });

  it("does not count or overwrite a concurrent password change", async () => {
    const { db, tx, rows } = database([{ id: "a", password: legacy }], "a");
    const result = await syncPasswordPepper(db, current, log);
    expect(tx.account.updateMany.mock.calls[0]?.[0].where).toEqual({ id: "a", password: legacy });
    expect(rows[0]?.password).toBe("concurrently-changed");
    expect(result.sealed).toBe(0);
  });

  it("rolls back on unknown keys and never reports conversions or secrets", async () => {
    const foreignSecret = "disposable-foreign-unit-test-key-abcdefgh";
    const foreign = createPasswordPepper({ secret: foreignSecret });
    const foreignHash = await foreign.hash("unit-test-password-123");
    const oldHash = await old.hash("unit-test-password-123");
    const { db, rows } = database([
      { id: "a", password: legacy },
      { id: "b", password: foreignHash },
      { id: "c", password: oldHash },
      { id: "d", password: foreignHash },
    ]);
    const events = vi.fn();
    const error = await syncPasswordPepper(db, current, log, events).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(PasswordPepperKeyError);
    if (!(error instanceof PasswordPepperKeyError)) throw new Error("expected key error");
    expect(error.count).toBe(3);
    expect(error.fingerprints).toEqual([old.fingerprint, foreign.fingerprint].sort());
    expect(events).toHaveBeenCalledOnce();
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "key-refused",
        count: 3,
        unknownFingerprints: error.fingerprints.join(", "),
      }),
    );
    expect(error.message).toContain(current.fingerprint);
    expect(error.message).toContain(old.fingerprint);
    expect(error.message).toContain(foreign.fingerprint);
    expect(error.message).toContain("BETTER_AUTH_SECRET_PREVIOUS");
    expect(error.message.includes(foreignSecret)).toBe(false);
    expect(error.message).toContain("those passwords must be reset");
    expect(rows[0]?.password).toBe(legacy);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("logs rotation completion even if no previous rows remain", async () => {
    const { db } = database([]);
    await syncPasswordPepper(db, rotating, log);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringMatching(/re-wrapped 0 .*can now be removed/),
    );
  });

  it("declares completion after re-wrapping every previous value and starts without the previous key", async () => {
    const { db, rows } = database([{ id: "a", password: old.reseal(legacy) }]);
    await expect(syncPasswordPepper(db, rotating, log)).resolves.toMatchObject({
      resealed: 1,
      remainingPrevious: 0,
    });
    expect(current.isAuthentic(rows[0]?.password ?? "")).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      expect.stringMatching(/re-wrapped 1 .*can now be removed/),
    );
    await expect(syncPasswordPepper(db, current, log)).resolves.toMatchObject({
      remainingPrevious: 0,
    });
    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("resetUnusablePasswords", () => {
  function fixture() {
    const valid = current.reseal(legacy) ?? "";
    const previous = old.reseal(legacy) ?? "";
    const foreign = createPasswordPepper({ secret: "disposable-foreign-recovery-key-0123456789" });
    return database([
      { id: "a", password: foreign.reseal(legacy) },
      { id: "b", password: `pw1:${current.fingerprint}:!` },
      { id: "c", password: `pw1:${old.fingerprint}:!` },
      { id: "d", password: "malformed" },
      { id: "e", password: legacy },
      { id: "f", password: valid },
      { id: "g", password: previous },
      { id: "h", password: null },
    ]);
  }

  it.each([undefined, 0, 3, 5])("changes nothing for confirm=%s", async (confirm) => {
    const { db, tx, rows } = fixture();
    const before = rows.map((row) => row.password);
    const result = await resetUnusablePasswords(
      db,
      rotating,
      confirm === undefined ? {} : { confirm },
    );
    expect(result).toEqual({
      count: 4,
      userIds: ["user-a", "user-b", "user-c", "user-d"],
      reset: 0,
    });
    expect(rows.map((row) => row.password)).toEqual(before);
    expect(tx.account.updateMany).not.toHaveBeenCalled();
  });

  it("replaces only unusable rows with authentic current-key passwords on exact confirmation", async () => {
    const { db, tx, rows } = fixture();
    const before = rows.map((row) => row.password);
    const hash = vi.spyOn(rotating, "hash");
    try {
      const result = await resetUnusablePasswords(db, rotating, { confirm: 4 });
      expect(result).toMatchObject({ count: 4, reset: 4 });
      expect(rows.slice(0, 4).every((row) => current.isAuthentic(row.password ?? ""))).toBe(true);
      expect(new Set(rows.slice(0, 4).map((row) => row.password)).size).toBe(4);
      expect(rows.slice(4).map((row) => row.password)).toEqual(before.slice(4));
      // One scrypt for the batch (better-auth/crypto directly), sealed per row
      // with a fresh nonce: the pepper's per-password hash is never called.
      expect(hash).not.toHaveBeenCalled();
      expect(tx.$executeRaw.mock.calls[0]?.[1]).toBe("password-pepper");
      expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.account.findMany.mock.invocationCallOrder[0] ?? 0,
      );
      for (const [args] of tx.account.updateMany.mock.calls) {
        const index = rows.findIndex((row) => row.id === args.where?.id);
        expect(args.where?.password).toBe(before[index]);
      }
    } finally {
      hash.mockRestore();
    }
  });

  it("preserves a concurrent recovery and reports the actual update count", async () => {
    const replacement = current.reseal(legacy) ?? "";
    const { db, rows } = database([{ id: "a", password: "malformed" }], "a", replacement);
    await expect(resetUnusablePasswords(db, current, { confirm: 1 })).resolves.toMatchObject({
      count: 1,
      reset: 0,
    });
    expect(rows[0]?.password).toBe(replacement);
  });

  it("pages over authentic rows to find unusable rows and deduplicates user ids", async () => {
    const valid = current.reseal(legacy);
    const { db, tx } = database(
      Array.from({ length: 501 }, (_, i) => ({
        id: String(i).padStart(4, "0"),
        userId: "same-user",
        password: i < 499 ? valid : "malformed",
      })),
    );
    await expect(resetUnusablePasswords(db, current)).resolves.toEqual({
      count: 2,
      userIds: ["same-user"],
      reset: 0,
    });
    expect(tx.account.findMany.mock.calls.map(([args]) => args.where?.id)).toEqual([
      undefined,
      { gt: "0499" },
    ]);
    expect(tx.account.findMany.mock.calls.every(([args]) => args.take === 500)).toBe(true);
  });
});
