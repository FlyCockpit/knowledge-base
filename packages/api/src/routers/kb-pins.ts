import type { Prisma } from "@knowledge-base/db";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { protectedProcedure } from "../index";
import { getKnowledgeBaseForViewer, mapKbDomainError } from "../lib/kb/bases";
import { getKbRuntime } from "../lib/kb/runtime";
import { createProcedureBudget } from "../lib/procedure-budget";

/** Pins a user may keep; also the bound of every pin read. */
export const KB_PIN_LIMIT = 50;

const kbId = z.string().min(1).max(64);

/**
 * Pin, unpin and reorder are cheap single-row writes, but each one is a
 * request a script could repeat; their own budget keeps them off every other.
 */
const consumePinWriteBudget = createProcedureBudget({
  keyPrefix: "rl:kb-pins-write",
  points: 60,
  durationSeconds: 60,
  failClosed: true,
  overBudgetMessage: (retryAfterSeconds) =>
    `Too many pin changes. Try again in ${retryAfterSeconds} seconds.`,
  unavailableMessage: "Pins are temporarily unavailable. Please try again.",
  unavailableLog: "[kb] pin write limiter unavailable, failing closed:",
});

/** Recently opened ids the sidebar may ask names for, at most. */
const KB_PIN_RECENT_LIMIT = 5;
/** Remembered ids a sidebar may send: enough to fill the recents after its pins. */
const KB_PIN_RECENT_ASKED = 10;

const pinSelect = { id: true, kbId: true, position: true } satisfies Prisma.KbPinSelect;

type PinClient = Pick<Prisma.TransactionClient, "kbPin" | "$queryRaw">;

/** The caller's pins in order (bounded by `KB_PIN_LIMIT`). */
async function pinRows(userId: string, client: Pick<PinClient, "kbPin"> = getKbRuntime().prisma) {
  return client.kbPin.findMany({
    where: { userId },
    select: pinSelect,
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    // pagination:audited — bounded by KB_PIN_LIMIT, the most pins a user can hold.
    take: KB_PIN_LIMIT,
  });
}

/**
 * The caller's live view of one KB, or null when they can't read it now
 * (no share, revoked, gone): a pin to it is simply not shown. Uses the same
 * admission as `kbs.get`, so pins never widen or narrow who sees what.
 */
async function readableKb(userId: string, id: string) {
  try {
    return await getKnowledgeBaseForViewer(getKbRuntime(), userId, id);
  } catch (error) {
    const mapped = mapKbDomainError(error);
    if (mapped?.code === "NOT_FOUND" || mapped?.code === "FORBIDDEN") return null;
    throw error;
  }
}

/**
 * Each pin's live view, in order: one admission at a time, like the KB list
 * itself (`listKbPage`), so a call never fans out more than one database
 * admission at once; bounded by `KB_PIN_LIMIT`.
 */
async function readableKbs(userId: string, ids: readonly string[]) {
  const out: Awaited<ReturnType<typeof readableKb>>[] = [];
  for (const id of ids) out.push(await readableKb(userId, id));
  return out;
}

/** The entries the caller can still read now, renamed from this check; one admission at a time. */
async function stillReadable(userId: string, entries: readonly { kbId: string }[]) {
  const live = await readableKbs(
    userId,
    entries.map((entry) => entry.kbId),
  );
  return entries.flatMap((entry, at) => {
    const kb = live[at];
    return kb ? [{ kbId: entry.kbId, name: kb.name, slug: kb.slug }] : [];
  });
}

/**
 * Runs `work` with the caller's pin set serialized: the caller's user row is
 * locked first, so concurrent pin / unpin / reorder of one person run one at a
 * time (the 50 cap and append order hold under races).
 */
async function withPinLock<T>(userId: string, work: (tx: PinClient) => Promise<T>): Promise<T> {
  return getKbRuntime().prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "user" WHERE id = ${userId} FOR UPDATE`;
    return work(tx);
  });
}

function stale(): never {
  throw new ORPCError("BAD_REQUEST", {
    message: "The pins changed meanwhile. Reload and try again.",
    data: { reason: "PINS_CHANGED" },
  });
}

function notFound(): never {
  throw new ORPCError("NOT_FOUND", { message: "Knowledge base not found" });
}

function rethrow(error: unknown): never {
  if (error instanceof ORPCError) throw error;
  const mapped = mapKbDomainError(error);
  if (mapped) {
    throw new ORPCError(
      mapped.code === "RATE_LIMITED" ? "TOO_MANY_REQUESTS" : "INTERNAL_SERVER_ERROR",
      {
        message: mapped.message,
        ...(mapped.retryAfterSeconds !== undefined
          ? { data: { retryAfterSeconds: mapped.retryAfterSeconds } }
          : {}),
      },
    );
  }
  throw error;
}

export const kbPinsRouter = {
  /**
   * The caller's pinned KBs in their order, only those they can read now,
   * with each KB's name for the sidebar. `recent`: the ids the sidebar
   * remembers as recently opened, newest first (at most 10); the first 5 that
   * aren't pinned and the caller can read now come back named, the rest are
   * silently left out (pinned ones are skipped before the limit applies).
   */
  list: protectedProcedure
    .input(z.object({ recent: z.array(kbId).max(KB_PIN_RECENT_ASKED).optional() }).optional())
    .handler(async ({ context, input }) => {
      const userId = context.session!.user.id;
      try {
        const rows = await pinRows(userId);
        const live = await readableKbs(
          userId,
          rows.map((row) => row.kbId),
        );
        const items = rows.flatMap((row, at) => {
          const kb = live[at];
          return kb ? [{ kbId: row.kbId, name: kb.name, slug: kb.slug }] : [];
        });
        // Pinned ones first out, then one admission at a time until 5 are named.
        const pinned = new Set(rows.map((row) => row.kbId));
        const recent: { kbId: string; name: string; slug: string }[] = [];
        for (const id of new Set(input?.recent ?? [])) {
          if (recent.length === KB_PIN_RECENT_LIMIT) break;
          if (pinned.has(id)) continue;
          const kb = await readableKb(userId, id);
          if (kb) recent.push({ kbId: id, name: kb.name, slug: kb.slug });
        }
        // Final live admission at the return boundary (as `listKbPage` does):
        // a KB revoked while later entries were read is left out here, and
        // each name comes from this last check.
        return {
          items: await stillReadable(userId, items),
          recent: await stillReadable(userId, recent),
        };
      } catch (error) {
        rethrow(error);
      }
    }),

  /** Pin a KB the caller can read, at the end. Pinning a pinned KB changes nothing. */
  pin: protectedProcedure.input(z.object({ kbId })).handler(async ({ context, input }) => {
    const userId = context.session!.user.id;
    try {
      await consumePinWriteBudget(userId);
      if (!(await readableKb(userId, input.kbId))) notFound();
      // At the cap, pins of KBs the caller can no longer read (not shown, not
      // removable from the sidebar) give their places back. Their admission
      // runs before the lock (it needs its own connections; the lock holds
      // one), one at a time, bounded by the cap; nothing about them is told.
      const before = await pinRows(userId);
      // The rows themselves (their ids): a pin removed and created again
      // meanwhile is a new row and is never reclaimed by this check.
      const unreadable =
        before.length >= KB_PIN_LIMIT
          ? await readableKbs(
              userId,
              before.map((row) => row.kbId),
            ).then((live) => before.filter((_, at) => !live[at]).map((row) => row.id))
          : [];
      // Count, position and insert under the caller's lock: two pins at once
      // can't both take the last place under the cap.
      return await withPinLock(userId, async (tx) => {
        let rows = await pinRows(userId, tx);
        if (rows.some((row) => row.kbId === input.kbId)) return { pinned: true };
        if (rows.length >= KB_PIN_LIMIT && unreadable.length > 0) {
          // Only those very rows, still present (a concurrent unpin may have
          // removed some; a re-pin is a new row and stays).
          const gone = rows.map((row) => row.id).filter((id) => unreadable.includes(id));
          if (gone.length > 0) {
            await tx.kbPin.deleteMany({ where: { userId, id: { in: gone } } });
            rows = rows.filter((row) => !gone.includes(row.id));
          }
        }
        if (rows.length >= KB_PIN_LIMIT) {
          throw new ORPCError("BAD_REQUEST", {
            message: `At most ${KB_PIN_LIMIT} knowledge bases can be pinned.`,
            data: { reason: "PIN_LIMIT", limit: KB_PIN_LIMIT },
          });
        }
        const position = rows.reduce((max, row) => Math.max(max, row.position + 1), 0);
        await tx.kbPin.create({ data: { userId, kbId: input.kbId, position } });
        return { pinned: true };
      });
    } catch (error) {
      rethrow(error);
    }
  }),

  /** Unpin a KB (also one the caller can no longer read). Unpinning twice is fine. */
  unpin: protectedProcedure.input(z.object({ kbId })).handler(async ({ context, input }) => {
    const userId = context.session!.user.id;
    try {
      await consumePinWriteBudget(userId);
      await withPinLock(userId, (tx) =>
        tx.kbPin.deleteMany({ where: { userId, kbId: input.kbId } }),
      );
      return { pinned: false };
    } catch (error) {
      rethrow(error);
    }
  }),

  /**
   * The new order of the pins the caller sees: exactly their readable pins,
   * each once. Pins they can't read now (not shown) keep their place after.
   */
  reorder: protectedProcedure
    .input(z.object({ kbIds: z.array(kbId).max(KB_PIN_LIMIT) }))
    .handler(async ({ context, input }) => {
      const userId = context.session!.user.id;
      try {
        await consumePinWriteBudget(userId);
        const listed = new Set(input.kbIds);
        if (listed.size !== input.kbIds.length) stale();
        // Which of the other pins the caller can still read (read admission
        // needs its own queries, so it runs before the lock)...
        const before = await pinRows(userId);
        // Every supplied id must be one of the caller's pins they can read now:
        // an unreadable pin is refused exactly like an unknown id (its
        // continued existence is never revealed).
        const pinnedBefore = new Set(before.map((row) => row.kbId));
        if (input.kbIds.some((id) => !pinnedBefore.has(id))) stale();
        const listedLive = await readableKbs(userId, input.kbIds);
        if (listedLive.some((kb) => !kb)) stale();
        const unlistedBefore = before.filter((row) => !listed.has(row.kbId));
        const unlistedLive = await readableKbs(
          userId,
          unlistedBefore.map((row) => row.kbId),
        );
        if (unlistedLive.some(Boolean)) stale();
        // ...then the set is validated and rewritten under the lock: a pin or
        // unpin since that read makes the reorder stale, never half-applied.
        await withPinLock(userId, async (tx) => {
          const rows = await pinRows(userId, tx);
          const pinned = new Set(rows.map((row) => row.kbId));
          if (input.kbIds.some((id) => !pinned.has(id))) stale();
          const unlisted = rows.filter((row) => !listed.has(row.kbId)).map((row) => row.kbId);
          const checked = unlistedBefore.map((row) => row.kbId);
          if (unlisted.length !== checked.length || unlisted.some((id, at) => id !== checked[at]))
            stale();
          const order = [...input.kbIds, ...unlisted];
          for (const [position, id] of order.entries())
            await tx.kbPin.updateMany({ where: { userId, kbId: id }, data: { position } });
        });
        return { kbIds: input.kbIds };
      } catch (error) {
        rethrow(error);
      }
    }),
};
