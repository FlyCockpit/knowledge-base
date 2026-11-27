/**
 * Startup step for the password pepper (./password-pepper.ts). Runs before the
 * server listens, in one transaction under a cluster-wide advisory lock (so
 * replicas starting together do the work once):
 *
 *   - seals every Better-Auth scrypt hash still stored unsealed (the one-time
 *     conversion of a database from before the pepper),
 *   - re-seals every value sealed under BETTER_AUTH_SECRET_PREVIOUS under the
 *     current key (rotation; no passwords needed), then says the previous
 *     secret can be removed,
 *   - refuses to start when a value is sealed under a key that is not
 *     configured: a wrong or lost BETTER_AUTH_SECRET would otherwise fail
 *     every sign-in silently. The transaction rolls back, so nothing changes.
 *
 * Only `account.password` holds password hashes (Better-Auth's credential
 * accounts). API keys, OTPs and verification tokens are not passwords.
 */
import { randomBytes } from "node:crypto";
import type prisma from "@knowledge-base/db";
import type { Prisma } from "@knowledge-base/db";
import { PASSWORD_PEPPER_DOCS, type PasswordPepperEvent } from "@knowledge-base/env/log-record";
import { hashPassword } from "better-auth/crypto";

import type { PasswordPepper } from "./password-pepper.js";
import { PasswordPepperKeyError } from "./password-pepper.js";

export { PasswordPepperKeyError };

import { PEPPER_PREFIX } from "./password-pepper.js";

type Db = Pick<typeof prisma, "$transaction">;

const LOCK_KEY = "password-pepper";
const PAGE_SIZE = 500;

export type PasswordPepperSyncResult = {
  fingerprint: string;
  /** Legacy unsealed hashes sealed now. */
  sealed: number;
  /** Previous-key values re-sealed under the current key now. */
  resealed: number;
  /** Values that are neither sealed nor a Better-Auth hash; they never verify. */
  malformed: number;
  /** Envelopes that fail structural or cryptographic validation. */
  corrupt: number;
  /** Fresh count after conversion, including corrupt previous-key values. */
  remainingPrevious: number;
};

type Log = { info(message: string): void; warn(message: string): void };

export async function syncPasswordPepper(
  db: Db,
  pepper: PasswordPepper,
  // Process output here goes only through @knowledge-base/env/log records:
  // the server passes `structured`; free-text lines are for tests and tools.
  log: Log = { info: () => {}, warn: () => {} },
  structured?: (event: PasswordPepperEvent) => void,
): Promise<PasswordPepperSyncResult> {
  const result = await db
    .$transaction(
      async (tx: Prisma.TransactionClient) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`;
        let sealed = 0;
        let resealed = 0;
        let malformed = 0;
        let corrupt = 0;
        const unknown = new Map<string, number>();
        let after: string | undefined;
        for (;;) {
          // Validate current-key envelopes too: a matching fingerprint does not
          // prove that the payload is intact or contains a password hash.
          const rows = await tx.account.findMany({
            where: {
              password: { not: null },
              ...(after ? { id: { gt: after } } : {}),
            },
            select: { id: true, password: true },
            orderBy: { id: "asc" },
            take: PAGE_SIZE,
          });
          for (const row of rows) {
            const stored = row.password;
            if (stored === null) continue;
            const kind = pepper.classify(stored);
            if (kind === "unknown-key") {
              const fingerprint = stored.split(":")[1] ?? "?";
              unknown.set(fingerprint, (unknown.get(fingerprint) ?? 0) + 1);
              continue;
            }
            if (kind === "malformed") {
              malformed += 1;
              continue;
            }
            if (kind === "corrupt" || (kind !== "legacy" && !pepper.isAuthentic(stored))) {
              corrupt += 1;
              continue;
            }
            if (kind === "current") continue;
            const next = pepper.reseal(stored);
            if (next === null) {
              // A previous-key value that fails authentication: corrupt.
              corrupt += 1;
              continue;
            }
            // Conditional on the value read, so a concurrent password change
            // (an old replica still serving) is never overwritten.
            const { count } = await tx.account.updateMany({
              where: { id: row.id, password: stored },
              data: { password: next },
            });
            if (count === 1) {
              if (kind === "legacy") sealed += 1;
              else resealed += 1;
            }
          }
          if (rows.length < PAGE_SIZE) break;
          after = rows[rows.length - 1]?.id;
        }
        if (unknown.size > 0) {
          const configured = [
            pepper.fingerprint,
            ...(pepper.previousFingerprint ? [pepper.previousFingerprint] : []),
          ];
          const total = [...unknown.values()].reduce((a, b) => a + b, 0);
          throw new PasswordPepperKeyError(total, [...unknown.keys()].sort(), configured);
        }
        const remainingPrevious = pepper.previousFingerprint
          ? await tx.account.count({
              where: {
                password: { startsWith: `${PEPPER_PREFIX}:${pepper.previousFingerprint}:` },
              },
            })
          : 0;
        return {
          fingerprint: pepper.fingerprint,
          sealed,
          resealed,
          malformed,
          corrupt,
          remainingPrevious,
        };
      },
      // A large conversion seals thousands of rows (AES only, no scrypt): allow
      // it more than Prisma's 5 s default, and wait for a sibling replica.
      { maxWait: 60_000, timeout: 600_000 },
    )
    .catch((error: unknown) => {
      if (error instanceof PasswordPepperKeyError && structured) {
        const listed = error.fingerprints.slice(0, 16);
        structured({
          event: "key-refused",
          unknownFingerprint: listed[0]!,
          ...(listed.length > 1 ? { unknownFingerprints: listed.join(", ") } : {}),
          fingerprint: pepper.fingerprint,
          ...(pepper.previousFingerprint
            ? { previousFingerprint: pepper.previousFingerprint }
            : {}),
          count: error.count,
          docs: PASSWORD_PEPPER_DOCS,
        });
      }
      throw error;
    });

  if (result.sealed > 0) {
    structured?.({ event: "sealed", count: result.sealed, fingerprint: result.fingerprint });
    log.info(
      `password pepper: sealed ${result.sealed} existing password hash(es) under key ${result.fingerprint}`,
    );
  }
  if (pepper.previousFingerprint && result.remainingPrevious === 0) {
    structured?.({
      event: "rewrapped-complete",
      count: result.resealed,
      fingerprint: result.fingerprint,
      previousFingerprint: pepper.previousFingerprint,
    });
    log.info(
      `password pepper: re-wrapped ${result.resealed} password hash(es) from key ${pepper.previousFingerprint} ` +
        `to key ${result.fingerprint}; none remain under the previous key, so BETTER_AUTH_SECRET_PREVIOUS can now be removed`,
    );
  }
  if (result.remainingPrevious > 0 && pepper.previousFingerprint) {
    structured?.({
      event: "previous-remaining",
      count: result.remainingPrevious,
      previousFingerprint: pepper.previousFingerprint,
      docs: PASSWORD_PEPPER_DOCS,
    });
    log.warn(
      `password pepper: ${result.remainingPrevious} password hash(es) are still under previous key ${pepper.previousFingerprint} ` +
        "(corrupt, or written by a replica still running the old configuration); keep BETTER_AUTH_SECRET_PREVIOUS set " +
        "and restart again; see docs/hosting.md § Password pepper",
    );
  }
  if (result.malformed + result.corrupt > 0) {
    structured?.({
      event: "unusable",
      count: result.malformed + result.corrupt,
      docs: PASSWORD_PEPPER_DOCS,
    });
    log.warn(
      `password pepper: ${result.malformed + result.corrupt} stored password value(s) are corrupt or not a password hash and can never sign in; ` +
        "run `pnpm auth:pepper:reset-unusable` (docs/hosting.md § Password pepper)",
    );
  }
  structured?.({ event: "ok", fingerprint: result.fingerprint });
  log.info(`password pepper: ok (key fp ${result.fingerprint})`);
  return result;
}

/** Owner-run recovery; dry-run unless the exact unusable row count is confirmed. */
export async function resetUnusablePasswords(
  db: Db,
  pepper: PasswordPepper,
  { confirm }: { confirm?: number } = {},
): Promise<{ count: number; userIds: string[]; reset: number }> {
  return db.$transaction(
    async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`;
      const unusable: { id: string; userId: string; password: string }[] = [];
      let after: string | undefined;
      for (;;) {
        const rows = await tx.account.findMany({
          where: { password: { not: null }, ...(after ? { id: { gt: after } } : {}) },
          select: { id: true, userId: true, password: true },
          orderBy: { id: "asc" },
          take: PAGE_SIZE,
        });
        for (const row of rows) {
          if (row.password === null) continue;
          if (pepper.classify(row.password) === "legacy" || pepper.isAuthentic(row.password))
            continue;
          unusable.push({ id: row.id, userId: row.userId, password: row.password });
        }
        if (rows.length < PAGE_SIZE) break;
        after = rows[rows.length - 1]?.id;
      }
      let reset = 0;
      if (confirm === unusable.length && unusable.length > 0) {
        // One scrypt for the whole batch (an unusable password nobody knows),
        // sealed per row with a fresh nonce, so recovery stays fast however
        // many rows a lost key affected.
        const inner = await hashPassword(randomBytes(32).toString("base64url"));
        for (const row of unusable) {
          const password = pepper.reseal(inner);
          if (password === null) throw new Error("password pepper: could not seal the reset value");
          const { count } = await tx.account.updateMany({
            where: { id: row.id, password: row.password },
            data: { password },
          });
          reset += count;
        }
      }
      return {
        count: unusable.length,
        userIds: [...new Set(unusable.map((row) => row.userId))],
        reset,
      };
    },
    { maxWait: 60_000, timeout: 600_000 },
  );
}
