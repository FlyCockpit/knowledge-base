import { z } from "zod";

import { cursorToken } from "./schemas";

/**
 * Pagination helpers. Two shapes, and only two:
 *
 * - **Paged reads** (a list a client scrolls) use {@link withCursor} +
 *   {@link cursorPage}: a composite keyset (`sortColumn`, `id`) carried in an
 *   opaque token.
 * - **Delete-as-you-scan** sweeps (push 410 cleanup, asset GC) use
 *   {@link forEachPage} + {@link keysetWhere}: `id > lastSeenId`, which stays
 *   correct while the visitor deletes the rows it was just handed.
 *
 * Nobody uses Prisma's `cursor:` / `skip: 1` option. Prisma's cursor is a
 * *row identity*: the cursor row must still exist when the next page is
 * fetched. Delete the row that happened to be the active cursor — a feed
 * row, a post, an asset — and the follow-up query matches nothing, so
 * "Load more" returns an empty page and the list silently ends early. A keyset
 * cursor compares values instead of identity, so a deleted cursor row costs
 * nothing: the next page is still everything below the recorded position.
 */

/** Base64url alphabet, no padding — what {@link encodeCursor} emits. */
const TOKEN_CHARS = /^[A-Za-z0-9_-]+$/;
/** Ids are cuid2-ish; keep the decoded half as tight as the wire schema. */
const CURSOR_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Must match the `max()` on `cursorToken` in `schemas.ts` — the wire bound. */
const MAX_TOKEN_LENGTH = 128;

export type Cursor = {
  /** The row's value for the list's sort column. */
  sortValue: Date;
  /** Tie-breaker: the row's id. */
  id: string;
};

/**
 * Encode a composite keyset position as an opaque, URL-safe token.
 * Format: `base64url("<iso8601>|<id>")`. Callers treat it as opaque — the
 * client never parses it, and the shape may change.
 *
 * Throws if the encoded token would be longer than {@link MAX_TOKEN_LENGTH},
 * because `cursorToken` would then reject the very token this list just
 * minted: page 2 would 400 instead of loading. That means the model's id is
 * longer than a cuid2 — fail here, at the row that caused it, rather than in a
 * client the next time it scrolls.
 */
export function encodeCursor(cursor: Cursor): string {
  const token = Buffer.from(`${cursor.sortValue.toISOString()}|${cursor.id}`, "utf8").toString(
    "base64url",
  );
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new Error(
      `encodeCursor: id "${cursor.id}" is ${cursor.id.length} chars, which encodes to a ${token.length}-char cursor; the wire schema accepts at most ${MAX_TOKEN_LENGTH}`,
    );
  }
  return token;
}

/**
 * Decode a token produced by {@link encodeCursor}, or `null` when the token is
 * malformed. Prefer {@link cursorTokenSchema} on the procedure input so a bad
 * token is a validation error rather than a 500 in the handler.
 */
export function decodeCursor(token: string): Cursor | null {
  if (!TOKEN_CHARS.test(token)) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(token, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const separator = decoded.indexOf("|");
  if (separator === -1) return null;
  const iso = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  if (!CURSOR_ID.test(id)) return null;
  const sortValue = new Date(iso);
  // Round-tripping the ISO string rejects `Invalid Date` and anything merely
  // Date-parseable ("2020", "Jan 3") rather than a token we minted.
  if (Number.isNaN(sortValue.getTime()) || sortValue.toISOString() !== iso) return null;
  return { sortValue, id };
}

/**
 * The wire schema for a pagination cursor: the shared string bounds from
 * `schemas.ts` plus a format check, so a tampered or stale-format token is
 * rejected as an input validation error instead of throwing inside a handler.
 */
export const cursorTokenSchema = cursorToken.refine((token) => decodeCursor(token) !== null, {
  message: "Invalid pagination cursor",
});

export const cursorPageInput = z.object({
  cursor: cursorTokenSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

export const offsetPageInput = z.object({
  offset: z.number().int().min(0).max(10_000).default(0),
  limit: z.number().int().min(1).max(100).default(20),
});

/** `take` for a cursor page: one extra row to detect `hasMore`. */
export function pageTake(limit: number): number {
  return limit + 1;
}

export type CursorDirection = "asc" | "desc";

/**
 * The composite-keyset `where` fragment for one page boundary.
 * `desc` → everything strictly below (`sortColumn`, `id`); `asc` → above.
 */
export type CursorKeyset<F extends string> = {
  OR: [
    { [K in F]: { lt: Date } | { gt: Date } },
    { [K in F]: Date } & { id: { lt: string } | { gt: string } },
  ];
};

/**
 * Build the keyset fragment for `cursor` on the column `field`.
 *
 * **This is a fragment, not a `where`.** It carries no ownership or visibility
 * filter, so it must never replace one. Combine it with {@link withCursor},
 * which ANDs it onto the caller's existing `where` — spreading it in at the top
 * level would clobber any sibling `OR` the caller already had (and with it, the
 * scoping that `OR` encoded).
 *
 * `direction` must match the query's `orderBy`, and that `orderBy` must be a
 * total order: `[{ <field>: dir }, { id: dir }]`. Without the `id` tie-breaker,
 * rows sharing a timestamp can repeat or vanish across pages.
 */
export function cursorWhere<F extends string>(
  field: F,
  cursor: Cursor,
  direction: CursorDirection,
): CursorKeyset<F> {
  const bound = direction === "desc" ? { lt: cursor.sortValue } : { gt: cursor.sortValue };
  const tieBreak = direction === "desc" ? { lt: cursor.id } : { gt: cursor.id };
  return {
    OR: [
      { [field]: bound } as { [K in F]: { lt: Date } | { gt: Date } },
      { [field]: cursor.sortValue, id: tieBreak } as { [K in F]: Date } & {
        id: { lt: string } | { gt: string };
      },
    ],
  };
}

/**
 * AND a page boundary onto an existing `where`.
 *
 * The existing `where` is preserved verbatim as the first `AND` member, so
 * ownership/visibility scoping can never be bypassed by a cursor. Returns
 * `{ AND: [where] }` on the first page (no token), which is equivalent to
 * `where` alone.
 *
 * ```ts
 * const items = await prisma.post.findMany({
 *   where: withCursor({ deletedAt: null }, "createdAt", input.cursor, "desc"),
 *   orderBy: [{ createdAt: "desc" }, { id: "desc" }],
 *   take: pageTake(limit),
 *   select,
 * });
 * const page = cursorPage(items, limit, "createdAt");
 * ```
 */
export function withCursor<W, F extends string>(
  where: W,
  field: F,
  token: string | undefined,
  direction: CursorDirection,
): { AND: Array<W | CursorKeyset<F>> } {
  const cursor = token ? decodeCursor(token) : null;
  return { AND: cursor ? [where, cursorWhere(field, cursor, direction)] : [where] };
}

/** A row that can anchor a composite cursor on the column `F`. */
export type CursorRow<F extends string> = { id: string } & { [K in F]: Date | null };

/**
 * Slice a `take: limit + 1` result into a page and the next cursor.
 *
 * The cursor encodes the last *returned* row (not the lookahead), so the next
 * page picks up immediately below it. `sortField` must be the column the query
 * ordered by, and every row the query can return must have it non-null —
 * filter nulls out in `where` (a null sort key has no place in a total order).
 */
export function cursorPage<F extends string, T extends CursorRow<F>>(
  items: T[],
  limit: number,
  sortField: F,
): { items: T[]; nextCursor: string | null } {
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  if (!hasMore) return { items: page, nextCursor: null };
  const last = page[page.length - 1];
  if (!last) return { items: page, nextCursor: null };
  const sortValue: Date | null = last[sortField];
  if (sortValue == null) {
    throw new Error(
      `cursorPage: row ${last.id} has a null ${sortField}; exclude null sort keys in the query's where clause`,
    );
  }
  return { items: page, nextCursor: encodeCursor({ sortValue, id: last.id }) };
}

export type PageQueryArgs = {
  take: number;
  /** Exclusive lower bound (`id > afterId`). Omit on the first page. */
  afterId?: string;
};

/**
 * Spread this into a Prisma `where` so a keyset scan does not use a
 * row-identity cursor. Prisma `cursor: { id }` requires that row to still
 * exist; scans that delete as they go (push 410s, asset cleanup) would skip the
 * rest of the table.
 *
 * It only ever sets the `id` key, so spreading is safe next to any other
 * filter:
 *
 * ```ts
 * where: { status: "PENDING", ...keysetWhere(page.afterId) }
 * ```
 *
 * The one exception: if your `where` already has an `id` filter, spreading
 * would silently drop one of the two. Put both inside an `AND` instead:
 *
 * ```ts
 * where: { AND: [{ id: { in: ids } }, keysetWhere(page.afterId)] }
 * ```
 *
 * For paged *reads* use {@link withCursor} instead: this helper orders by `id`,
 * which is a cuid2 and therefore not chronological.
 */
export function keysetWhere(afterId: string | undefined): { id?: { gt: string } } {
  return afterId ? { id: { gt: afterId } } : {};
}

/**
 * Hard ceiling on `forEachPage` iterations. At the page sizes these scans use
 * this is far past any real table; reaching it means the loop is not advancing.
 */
const MAX_SCAN_PAGES = 100_000;

/**
 * Walk a `findMany` ordered by unique `id` asc until a short page.
 * Uses keyset pagination (`id > lastSeenId`), not Prisma `cursor`/`skip: 1`,
 * so `visit` may delete the rows it just saw without aborting the scan.
 * Capture of `afterId` happens *before* `visit`.
 *
 * `fetchPage` **must** apply {@link keysetWhere} to `args.afterId` and order by
 * `id` asc. Forgetting it is the copy-paste mistake this shape invites, and it
 * is invisible in a passing test: the scan re-reads page 1 forever, so a
 * cleanup job silently loops instead of finishing. Two guards catch it — each
 * page after the first must start strictly after `afterId` (throws on page 2),
 * and the loop refuses to run past {@link MAX_SCAN_PAGES}.
 */
export async function forEachPage<T extends { id: string }>(
  fetchPage: (args: PageQueryArgs) => Promise<T[]>,
  pageSize: number,
  visit: (rows: T[]) => void | Promise<void>,
): Promise<void> {
  if (pageSize < 1) {
    throw new Error("forEachPage pageSize must be >= 1");
  }
  let afterId: string | undefined;
  for (let pages = 0; ; pages++) {
    if (pages >= MAX_SCAN_PAGES) {
      throw new Error(
        `forEachPage: gave up after ${MAX_SCAN_PAGES} pages — the most likely cause is that fetchPage did not apply keysetWhere(afterId), so it keeps returning the same page`,
      );
    }
    const rows = await fetchPage({
      take: pageSize,
      ...(afterId ? { afterId } : {}),
    });
    if (rows.length === 0) break;
    const firstId = rows[0]?.id;
    if (afterId !== undefined && firstId !== undefined && firstId <= afterId) {
      throw new Error(
        `forEachPage: page starts at id "${firstId}", which is not after "${afterId}" — fetchPage did not apply keysetWhere(afterId), or did not order by id asc`,
      );
    }
    const lastId = rows[rows.length - 1]?.id;
    await visit(rows);
    if (rows.length < pageSize) break;
    if (!lastId) break;
    afterId = lastId;
  }
}
