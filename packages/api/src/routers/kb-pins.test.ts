import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/db", async () => {
  const { mockDeep } = await import("vitest-mock-extended");
  const db = mockDeep<{ appSetting: { findMany: () => Promise<unknown[]> } }>();
  // The session gate reads the instance settings (2FA policy).
  db.appSetting.findMany.mockResolvedValue([]);
  return { default: db };
});
vi.mock("../lib/procedure-budget", () => ({ createProcedureBudget: () => async () => {} }));

const access = vi.hoisted(() => ({
  /** kbId → readable by which users */
  readers: new Map<string, Set<string>>(),
}));
vi.mock("../lib/kb/bases", async () => {
  const { KbDomainError } = await import("../lib/kb/errors");
  return {
    getKnowledgeBaseForViewer: vi.fn(async (_runtime: unknown, userId: string, kbId: string) => {
      if (!access.readers.get(kbId)?.has(userId))
        throw new KbDomainError("NOT_FOUND", "Knowledge base not found");
      return { id: kbId, name: `KB ${kbId}`, slug: `kb-${kbId}` };
    }),
    mapKbDomainError: (error: unknown) => (error instanceof KbDomainError ? error : null),
  };
});

import type { Session } from "@knowledge-base/auth";
import { mockDeep } from "vitest-mock-extended";

import type { Context } from "../context";
import { configureKbRuntime, resetKbRuntimeForTests } from "../lib/kb/runtime";
import { KB_PIN_LIMIT, kbPinsRouter } from "./kb-pins";

type Row = { userId: string; kbId: string; position: number; createdAt: Date };
let rows: Row[] = [];
/** Each row object's own id (a pin removed and created again is a new row). */
const rowIds = new WeakMap<Row, string>();
let nextRowId = 0;
const rowId = (row: Row) => {
  let id = rowIds.get(row);
  if (!id) {
    id = `row${++nextRowId}`;
    rowIds.set(row, id);
  }
  return id;
};
/** What ran, in order: the user-row lock and the pin reads/writes. */
let calls: string[] = [];
/** Runs right after a lock is taken (a test changes the pins "meanwhile"). */
let afterLock: (() => void) | null = null;

function fakePrisma() {
  const prisma = mockDeep<{
    kbPin: {
      findMany: (args: { where: { userId: string }; take: number }) => Promise<unknown>;
      create: (args: { data: Omit<Row, "createdAt"> }) => Promise<unknown>;
      deleteMany: (args: {
        where: { userId: string; kbId?: string | { in: string[] }; id?: { in: string[] } };
      }) => Promise<unknown>;
      updateMany: (args: {
        where: { userId: string; kbId: string };
        data: { position: number };
      }) => Promise<unknown>;
    };
    $transaction: (work: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  }>();
  prisma.kbPin.findMany.mockImplementation(async ({ where, take }) => {
    calls.push("findMany");
    return rows
      .filter((row) => row.userId === where.userId)
      .sort((a, b) => a.position - b.position)
      .slice(0, take)
      .map((row) => ({ id: rowId(row), kbId: row.kbId, position: row.position }));
  });
  prisma.kbPin.create.mockImplementation(async ({ data }) => {
    calls.push("create");
    if (rows.some((row) => row.userId === data.userId && row.kbId === data.kbId))
      throw Object.assign(new Error("unique"), { code: "P2002" });
    rows.push({ ...data, createdAt: new Date() });
    return data;
  });
  prisma.kbPin.deleteMany.mockImplementation(async ({ where }) => {
    const matches = (row: Row) =>
      where.id
        ? where.id.in.includes(rowId(row))
        : typeof where.kbId === "string"
          ? row.kbId === where.kbId
          : (where.kbId?.in.includes(row.kbId) ?? false);
    const before = rows.length;
    rows = rows.filter((row) => !(row.userId === where.userId && matches(row)));
    return { count: before - rows.length };
  });
  prisma.kbPin.updateMany.mockImplementation(async ({ where, data }) => {
    for (const row of rows)
      if (row.userId === where.userId && row.kbId === where.kbId) row.position = data.position;
    return { count: 1 };
  });
  prisma.$queryRaw.mockImplementation(async (strings, ...values) => {
    calls.push(`lock:${strings.join("?")}:${String(values[0])}`);
    afterLock?.();
    return [];
  });
  // Interactive transactions run one at a time, as the row lock makes them.
  let queue: Promise<unknown> = Promise.resolve();
  prisma.$transaction.mockImplementation(async (work) => {
    const run = queue.then(() => work(prisma));
    queue = run.catch(() => undefined);
    return run;
  });
  return prisma;
}

function as(userId: string) {
  const context: Context = {
    session: {
      user: { id: userId, email: `${userId}@example.com`, role: "user" },
      session: { id: "s", userId, expiresAt: new Date(Date.now() + 60_000) },
    } as unknown as Session,
  };
  return createRouterClient(kbPinsRouter, { context });
}

const readable = (kbId: string, ...users: string[]) => access.readers.set(kbId, new Set(users));
const reason = (error: unknown) => (error as ORPCError<string, { reason?: string }>).data?.reason;

describe("kbPins router", () => {
  beforeEach(() => {
    rows = [];
    calls = [];
    afterLock = null;
    access.readers.clear();
    resetKbRuntimeForTests();
    configureKbRuntime({ prisma: fakePrisma() as never } as never);
  });

  it("requires a session", async () => {
    const client = createRouterClient(kbPinsRouter, { context: { session: null } });
    await expect(client.list()).rejects.toBeInstanceOf(ORPCError);
  });

  it("pins at the end, idempotently, and lists in order with names", async () => {
    readable("a", "u1");
    readable("b", "u1");
    const u1 = as("u1");
    await u1.pin({ kbId: "b" });
    await u1.pin({ kbId: "a" });
    await u1.pin({ kbId: "b" });
    expect(rows.filter((row) => row.userId === "u1")).toHaveLength(2);
    expect((await u1.list()).items).toEqual([
      { kbId: "b", name: "KB b", slug: "kb-b" },
      { kbId: "a", name: "KB a", slug: "kb-a" },
    ]);
  });

  it("refuses a KB the caller can't read, as not found", async () => {
    readable("secret", "owner");
    await expect(as("u1").pin({ kbId: "secret" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(rows).toHaveLength(0);
  });

  it("caps the number of pins", async () => {
    for (let i = 0; i < KB_PIN_LIMIT; i++) {
      readable(`k${i}`, "u1");
      rows.push({ userId: "u1", kbId: `k${i}`, position: i, createdAt: new Date() });
    }
    readable("one-more", "u1");
    const error = await as("u1")
      .pin({ kbId: "one-more" })
      .catch((e: unknown) => e);
    expect(reason(error)).toBe("PIN_LIMIT");
  });

  it("at the cap, gives back the places of pins the caller can no longer read", async () => {
    for (let i = 0; i < KB_PIN_LIMIT; i++) {
      readable(`k${i}`, "u2");
      rows.push({ userId: "u1", kbId: `k${i}`, position: i, createdAt: new Date() });
    }
    rows.push({ userId: "u2", kbId: "k0", position: 0, createdAt: new Date() });
    readable("one-more", "u1");
    await expect(as("u1").pin({ kbId: "one-more" })).resolves.toEqual({ pinned: true });
    // Only the caller's unreadable rows went; another user's pin stays.
    expect(rows.filter((row) => row.userId === "u1").map((row) => row.kbId)).toEqual(["one-more"]);
    expect(rows.filter((row) => row.userId === "u2")).toHaveLength(1);
  });

  it("reclaims only the very rows found unreadable: a pin created again meanwhile stays", async () => {
    for (let i = 0; i < KB_PIN_LIMIT - 1; i++) {
      readable(`k${i}`, "u1");
      rows.push({ userId: "u1", kbId: `k${i}`, position: i, createdAt: new Date() });
    }
    // S is unreadable when the pin request checks, before it takes the lock.
    rows.push({ userId: "u1", kbId: "s", position: 49, createdAt: new Date() });
    readable("x", "u1");
    // Meanwhile S's access comes back and another tab unpins and pins it again (a new row).
    afterLock = () => {
      readable("s", "u1");
      rows = rows.filter((row) => row.kbId !== "s");
      rows.push({ userId: "u1", kbId: "s", position: 49, createdAt: new Date() });
    };
    const error = await as("u1")
      .pin({ kbId: "x" })
      .catch((e: unknown) => e);
    expect(reason(error)).toBe("PIN_LIMIT");
    expect(rows.some((row) => row.kbId === "s")).toBe(true);
    expect(rows.some((row) => row.kbId === "x")).toBe(false);
  });

  it("hides a pin once access is lost, and never shows another user's pins", async () => {
    readable("a", "u1", "u2");
    readable("b", "u1");
    await as("u1").pin({ kbId: "a" });
    await as("u1").pin({ kbId: "b" });
    await as("u2").pin({ kbId: "a" });
    access.readers.get("b")!.delete("u1");
    expect((await as("u1").list()).items.map((item) => item.kbId)).toEqual(["a"]);
    expect((await as("u2").list()).items.map((item) => item.kbId)).toEqual(["a"]);
    expect((await as("u3").list()).items).toEqual([]);
  });

  it("unpins, also twice, and only the caller's own pin", async () => {
    readable("a", "u1", "u2");
    await as("u1").pin({ kbId: "a" });
    await as("u2").pin({ kbId: "a" });
    await as("u1").unpin({ kbId: "a" });
    await as("u1").unpin({ kbId: "a" });
    expect(rows.map((row) => row.userId)).toEqual(["u2"]);
  });

  it("reorders an exact permutation of the visible pins; hidden ones keep their place after", async () => {
    for (const id of ["a", "b", "c", "gone"]) readable(id, "u1");
    const u1 = as("u1");
    for (const id of ["a", "b", "gone", "c"]) await u1.pin({ kbId: id });
    access.readers.get("gone")!.delete("u1");
    await u1.reorder({ kbIds: ["c", "a", "b"] });
    expect(
      rows
        .filter((row) => row.userId === "u1")
        .sort((x, y) => x.position - y.position)
        .map((row) => row.kbId),
    ).toEqual(["c", "a", "b", "gone"]);
    expect((await u1.list()).items.map((item) => item.kbId)).toEqual(["c", "a", "b"]);
  });

  it("refuses a reorder that is not the current set of visible pins", async () => {
    for (const id of ["a", "b"]) readable(id, "u1");
    const u1 = as("u1");
    await u1.pin({ kbId: "a" });
    await u1.pin({ kbId: "b" });
    for (const kbIds of [["a"], ["a", "a"], ["a", "b", "x"], ["b", "a", "a"]]) {
      const error = await u1.reorder({ kbIds }).catch((e: unknown) => e);
      expect(reason(error)).toBe("PINS_CHANGED");
    }
  });

  it("refuses a revoked pin named in a reorder exactly like an unknown id", async () => {
    for (const id of ["a", "b", "s"]) readable(id, "u1");
    const u1 = as("u1");
    for (const id of ["a", "b", "s"]) await u1.pin({ kbId: id });
    access.readers.get("s")!.delete("u1");
    const revoked = await u1.reorder({ kbIds: ["s", "b", "a"] }).catch((e: unknown) => e);
    const unknown = await u1.reorder({ kbIds: ["zz", "b", "a"] }).catch((e: unknown) => e);
    expect(reason(revoked)).toBe("PINS_CHANGED");
    expect(reason(unknown)).toBe("PINS_CHANGED");
    expect((revoked as { message?: string }).message).toBe(
      (unknown as { message?: string }).message,
    );
    // Nothing was rewritten.
    expect(
      rows
        .filter((row) => row.userId === "u1")
        .sort((x, y) => x.position - y.position)
        .map((row) => row.kbId),
    ).toEqual(["a", "b", "s"]);
  });

  it("pins under the caller's row lock: the lock comes before the count and the insert", async () => {
    readable("a", "u1");
    await as("u1").pin({ kbId: "a" });
    expect(calls).toEqual([
      // The pre-lock read (admission of possibly reclaimable pins runs before
      // the lock: it needs connections of its own), then count + insert under it.
      "findMany",
      'lock:SELECT 1 FROM "user" WHERE id = ? FOR UPDATE:u1',
      "findMany",
      "create",
    ]);
  });

  it("keeps the cap with two pins at once at 49", async () => {
    for (let i = 0; i < KB_PIN_LIMIT - 1; i++) {
      readable(`k${i}`, "u1");
      rows.push({ userId: "u1", kbId: `k${i}`, position: i, createdAt: new Date() });
    }
    readable("x", "u1");
    readable("y", "u1");
    const u1 = as("u1");
    // Both requests start before either finishes.
    const first = u1.pin({ kbId: "x" }).then(
      () => "pinned",
      (error: unknown) => reason(error),
    );
    const second = u1.pin({ kbId: "y" }).then(
      () => "pinned",
      (error: unknown) => reason(error),
    );
    expect([await first, await second].sort()).toEqual(["PIN_LIMIT", "pinned"]);
    expect(rows.filter((row) => row.userId === "u1")).toHaveLength(KB_PIN_LIMIT);
  });

  it("validates a reorder against the pins as they are under the lock", async () => {
    for (const id of ["a", "b", "c", "d"]) readable(id, "u1");
    const u1 = as("u1");
    for (const id of ["a", "b", "c"]) await u1.pin({ kbId: id });
    // Another tab unpins b and c and pins d while this reorder waits for the lock.
    afterLock = () => {
      afterLock = null;
      rows = rows.filter((row) => row.kbId === "a");
      rows.push({ userId: "u1", kbId: "d", position: 1, createdAt: new Date() });
    };
    const error = await u1.reorder({ kbIds: ["c", "b", "a"] }).catch((e: unknown) => e);
    expect(reason(error)).toBe("PINS_CHANGED");
    expect(rows.find((row) => row.kbId === "a")?.position).toBe(0);
  });

  it("names recent KBs the caller can read now, and leaves the rest out", async () => {
    readable("r1", "u1");
    readable("secret", "owner");
    const result = await as("u1").list({ recent: ["r1", "secret", "missing", "r1"] });
    expect(result.recent).toEqual([{ kbId: "r1", name: "KB r1", slug: "kb-r1" }]);
    await expect(
      as("u1").list({ recent: Array.from({ length: 11 }, (_, i) => `x${i}`) }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it("rechecks every entry at the return boundary: one revoked during later reads is left out", async () => {
    readable("a", "u1");
    readable("r1", "u1");
    readable("r2", "u1");
    await as("u1").pin({ kbId: "a" });
    const { getKnowledgeBaseForViewer } = await import("../lib/kb/bases");
    const viewer = vi.mocked(getKnowledgeBaseForViewer);
    const original = viewer.getMockImplementation()!;
    // Reading the second recent KB revokes the pinned one and the first recent one.
    viewer.mockImplementation(async (runtime, userId, kbId) => {
      if (kbId === "r2") {
        access.readers.get("a")!.delete("u1");
        access.readers.get("r1")!.delete("u1");
      }
      return original(runtime, userId, kbId);
    });
    try {
      const result = await as("u1").list({ recent: ["r1", "r2"] });
      expect(result.items).toEqual([]);
      expect(result.recent.map((kb) => kb.kbId)).toEqual(["r2"]);
    } finally {
      viewer.mockImplementation(original);
    }
  });

  it("skips pinned bases before taking the 5 recent ones", async () => {
    const u1 = as("u1");
    const ids = Array.from({ length: 10 }, (_, i) => `r${i}`);
    for (const id of ids) readable(id, "u1");
    // The five most recently opened are pinned.
    for (const id of ids.slice(0, 5)) await u1.pin({ kbId: id });
    const result = await u1.list({ recent: ids });
    expect(result.recent.map((kb) => kb.kbId)).toEqual(["r5", "r6", "r7", "r8", "r9"]);
  });
});
