import { describe, expect, it } from "vitest";

import {
  type Cursor,
  cursorPage,
  cursorPageInput,
  cursorTokenSchema,
  cursorWhere,
  decodeCursor,
  encodeCursor,
  forEachPage,
  keysetWhere,
  offsetPageInput,
  pageTake,
  withCursor,
} from "./pagination";

describe("pageTake", () => {
  it("requests one extra row so the caller can detect hasMore", () => {
    expect(pageTake(20)).toBe(21);
    expect(pageTake(1)).toBe(2);
  });
});

const t0 = new Date("2026-01-03T00:00:00.000Z");
const t1 = new Date("2026-01-02T00:00:00.000Z");
const t2 = new Date("2026-01-01T00:00:00.000Z");
const row = (id: string, createdAt: Date) => ({ id, createdAt });

describe("encodeCursor / decodeCursor", () => {
  it("round-trips a composite position through an opaque url-safe token", () => {
    const cursor: Cursor = { sortValue: t0, id: "abc_123-XYZ" };
    const token = encodeCursor(cursor);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token).not.toContain("=");
    expect(decodeCursor(token)).toEqual(cursor);
  });

  it("stays inside the wire schema's length bound", () => {
    const token = encodeCursor({ sortValue: t0, id: "c".repeat(32) });
    expect(cursorTokenSchema.safeParse(token).success).toBe(true);
  });

  it.each([
    ["not base64url", "not a token!"],
    ["empty", ""],
    ["no separator", Buffer.from("2026-01-03T00:00:00.000Z", "utf8").toString("base64url")],
    ["empty id", Buffer.from("2026-01-03T00:00:00.000Z|", "utf8").toString("base64url")],
    ["bad id chars", Buffer.from("2026-01-03T00:00:00.000Z|a b", "utf8").toString("base64url")],
    ["not a date", Buffer.from("nope|abc", "utf8").toString("base64url")],
    // Date-parseable, but not a shape we ever minted.
    ["loose date", Buffer.from("2026|abc", "utf8").toString("base64url")],
    ["a bare row id (the old format)", "clx0000000000000000000000"],
  ])("rejects %s", (_label, token) => {
    expect(decodeCursor(token)).toBeNull();
    expect(cursorTokenSchema.safeParse(token).success).toBe(false);
  });
});

describe("cursorWhere", () => {
  const cursor: Cursor = { sortValue: t1, id: "b" };

  it("bounds a desc list from below, breaking ties on id", () => {
    expect(cursorWhere("createdAt", cursor, "desc")).toEqual({
      OR: [{ createdAt: { lt: t1 } }, { createdAt: t1, id: { lt: "b" } }],
    });
  });

  it("mirrors for asc", () => {
    expect(cursorWhere("createdAt", cursor, "asc")).toEqual({
      OR: [{ createdAt: { gt: t1 } }, { createdAt: t1, id: { gt: "b" } }],
    });
  });

  it("works on whichever column the list is ordered by", () => {
    expect(cursorWhere("updatedAt", cursor, "desc")).toEqual({
      OR: [{ updatedAt: { lt: t1 } }, { updatedAt: t1, id: { lt: "b" } }],
    });
  });
});

describe("withCursor", () => {
  it("preserves the caller's scope as the first AND member", () => {
    const scope = { ownerId: "u1", OR: [{ visibility: "PUBLIC" }] };
    expect(withCursor(scope, "createdAt", undefined, "desc")).toEqual({ AND: [scope] });
    expect(
      withCursor(scope, "createdAt", encodeCursor({ sortValue: t1, id: "b" }), "desc"),
    ).toEqual({
      AND: [scope, { OR: [{ createdAt: { lt: t1 } }, { createdAt: t1, id: { lt: "b" } }] }],
    });
  });

  it("ignores a token that does not decode rather than dropping the scope", () => {
    const scope = { ownerId: "u1" };
    expect(withCursor(scope, "createdAt", "garbage!", "desc")).toEqual({ AND: [scope] });
  });
});

describe("cursorPage", () => {
  it("returns the full list and a null cursor when there is no lookahead", () => {
    const items = [row("a", t0), row("b", t1)];
    expect(cursorPage(items, 20, "createdAt")).toEqual({ items, nextCursor: null });
  });

  it("slices the lookahead row and encodes the last RETURNED row", () => {
    const items = [row("a", t0), row("b", t1), row("c", t2)];
    const page = cursorPage(items, 2, "createdAt");
    expect(page.items).toEqual([row("a", t0), row("b", t1)]);
    expect(decodeCursor(page.nextCursor as string)).toEqual({ sortValue: t1, id: "b" });
  });

  it("throws rather than emitting a cursor for a null sort key", () => {
    const items = [
      { id: "a", publishedAt: null },
      { id: "b", publishedAt: null },
    ];
    expect(() => cursorPage(items, 1, "publishedAt")).toThrow(/null publishedAt/);
  });
});

/**
 * The bug this design exists for: Prisma's `cursor: { id }` is a row identity,
 * so deleting the row that anchored page 1 made page 2 come back empty and the
 * client stopped scrolling. A keyset compares values, so the boundary outlives
 * the row.
 */
describe("keyset paging over a mutating table", () => {
  const query = (store: Array<{ id: string; createdAt: Date }>, token: string | undefined) => {
    const cursor = token ? decodeCursor(token) : null;
    const rows = store
      .filter(
        (r) =>
          !cursor ||
          r.createdAt < cursor.sortValue ||
          (r.createdAt.getTime() === cursor.sortValue.getTime() && r.id < cursor.id),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
    return cursorPage(rows.slice(0, pageTake(1)), 1, "createdAt");
  };

  it("still returns the next page when the cursor row was deleted between loads", () => {
    const store = [row("a", t0), row("b", t1), row("c", t2)];
    const first = query(store, undefined);
    expect(first.items.map((r) => r.id)).toEqual(["a"]);

    // The row the cursor points at is deleted before "Load more" fires.
    store.splice(
      store.findIndex((r) => r.id === "a"),
      1,
    );

    const second = query(store, first.nextCursor as string);
    expect(second.items.map((r) => r.id)).toEqual(["b"]);
    const third = query(store, second.nextCursor as string);
    expect(third.items.map((r) => r.id)).toEqual(["c"]);
    expect(third.nextCursor).toBeNull();
  });

  it("breaks ties on id when a whole page shares one timestamp", () => {
    const store = [row("a", t0), row("b", t0), row("c", t0)];
    const seen: string[] = [];
    let token: string | undefined;
    for (let i = 0; i < 3; i += 1) {
      const page = query(store, token);
      for (const r of page.items) seen.push(r.id);
      token = page.nextCursor ?? undefined;
      if (!token) break;
    }
    // desc on both keys: same timestamp, so id descends.
    expect(seen).toEqual(["c", "b", "a"]);
    expect(new Set(seen).size).toBe(3);
  });
});

describe("cursorPageInput", () => {
  it("defaults limit to 20 and caps it at 100", () => {
    expect(cursorPageInput.parse({})).toEqual({ limit: 20 });
    const token = encodeCursor({ sortValue: t0, id: "abc" });
    expect(cursorPageInput.parse({ limit: 100, cursor: token })).toEqual({
      limit: 100,
      cursor: token,
    });
    expect(cursorPageInput.safeParse({ limit: 101 }).success).toBe(false);
    expect(cursorPageInput.safeParse({ cursor: "x".repeat(129) }).success).toBe(false);
    // A malformed token is an input validation error, not a 500 in the handler.
    expect(cursorPageInput.safeParse({ cursor: "abc" }).success).toBe(false);
  });
});

describe("offsetPageInput", () => {
  it("caps offset at 10_000", () => {
    expect(offsetPageInput.parse({})).toEqual({ offset: 0, limit: 20 });
    expect(offsetPageInput.parse({ offset: 10_000, limit: 50 })).toEqual({
      offset: 10_000,
      limit: 50,
    });
    expect(offsetPageInput.safeParse({ offset: 10_001 }).success).toBe(false);
    expect(offsetPageInput.safeParse({ offset: -1 }).success).toBe(false);
  });
});

describe("forEachPage", () => {
  it("walks keyset pages until a short page", async () => {
    const pages = [[{ id: "1" }, { id: "2" }], [{ id: "3" }]];
    const calls: Array<{ take: number; afterId?: string }> = [];
    const seen: string[] = [];

    await forEachPage(
      async (args) => {
        calls.push(args);
        return pages.shift() ?? [];
      },
      2,
      (rows) => {
        for (const row of rows) seen.push(row.id);
      },
    );

    expect(seen).toEqual(["1", "2", "3"]);
    expect(calls).toEqual([{ take: 2 }, { take: 2, afterId: "2" }]);
  });

  it("advances from the last id even when visit deletes that row", async () => {
    const store = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const seen: string[] = [];

    await forEachPage(
      async ({ take, afterId }) =>
        store.filter((row) => (afterId ? row.id > afterId : true)).slice(0, take),
      2,
      async (rows) => {
        for (const row of rows) seen.push(row.id);
        // Delete the page, including the row a Prisma cursor would need.
        for (const row of rows) {
          const i = store.findIndex((r) => r.id === row.id);
          if (i >= 0) store.splice(i, 1);
        }
      },
    );

    expect(seen).toEqual(["a", "b", "c"]);
    expect(store).toEqual([]);
  });

  it("throws on page 2 when fetchPage ignores afterId", async () => {
    // The copy-paste mistake: a findMany that never spreads keysetWhere, so
    // every page is page 1. Caught at the second fetch, not after 100k of them.
    const store = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    let fetches = 0;

    await expect(
      forEachPage(
        async ({ take }) => {
          fetches += 1;
          return store.slice(0, take);
        },
        2,
        () => {},
      ),
    ).rejects.toThrow(/did not apply keysetWhere/);
    expect(fetches).toBe(2);
  });

  it("gives up rather than looping forever when pages never run short", async () => {
    // Pathological: every page advances by one id but the source never ends.
    // The cap is the backstop for a fetchPage the first-row guard cannot catch.
    let n = 0;
    await expect(
      forEachPage(
        async ({ take }) =>
          Array.from({ length: take }, () => ({ id: `id-${String(++n).padStart(9, "0")}` })),
        2,
        () => {},
      ),
    ).rejects.toThrow(/gave up after 100000 pages/);
  });

  it("stops immediately on an empty first page", async () => {
    let fetches = 0;
    await forEachPage(
      async () => {
        fetches += 1;
        return [];
      },
      10,
      () => {
        throw new Error("should not visit");
      },
    );
    expect(fetches).toBe(1);
  });
});

describe("keysetWhere", () => {
  it("is empty on the first page and exclusive after that", () => {
    expect(keysetWhere(undefined)).toEqual({});
    expect(keysetWhere("abc")).toEqual({ id: { gt: "abc" } });
  });
});

describe("encodeCursor token bound", () => {
  it("throws rather than minting a cursor the wire schema would reject", () => {
    const id = "x".repeat(90);
    expect(() => encodeCursor({ sortValue: t0, id })).toThrow(/is 90 chars/);
    expect(() => encodeCursor({ sortValue: t0, id })).toThrow(/at most 128/);
  });

  it("accepts a normal cuid2-length id", () => {
    const token = encodeCursor({ sortValue: t0, id: "a".repeat(24) });
    expect(cursorTokenSchema.safeParse(token).success).toBe(true);
  });
});
