import { isUserBanned } from "@knowledge-base/auth/ban";
import { hasRole } from "@knowledge-base/auth/roles";
import { ORPCError } from "@orpc/server";
import type { LockQuery } from "./kb/lock";

/** Shared by role, archive and account teardown inside their owning transaction.
 * The identity authority lock serializes these paths with all other policy writers.
 * Lock eligible admin rows too: a Serializable policy writer may have taken its
 * snapshot before waiting for authority, while teardown uses READ COMMITTED.
 * A removed/changed admin must cause that stale snapshot to fail, not be counted.
 */
export async function assertAdminRemovalAllowed(
  query: LockQuery,
  userId: string,
  nextRole?: string,
) {
  const result = await query<{
    id: string;
    role: string | null;
    emailVerified: boolean;
    banned: boolean | null;
    banExpires: Date | null;
  }>(`SELECT id, role, "emailVerified", banned, "banExpires" FROM "user" WHERE id = $1`, [userId]);
  const target = result.rows[0];
  if (!target) throw new ORPCError("NOT_FOUND", { data: { reason: "USER_NOT_FOUND" } });
  if (
    hasRole(nextRole, "admin") ||
    !hasRole(target.role, "admin") ||
    !target.emailVerified ||
    isUserBanned(target)
  )
    return target;
  const admins = await query<{ count: number }>(`
    SELECT count(*)::int AS count FROM (
    SELECT u.id FROM "user" u
    WHERE u.role ILIKE '%admin%'
      AND EXISTS (
        SELECT 1 FROM unnest(string_to_array(u.role, ',')) AS r(token)
        WHERE r.token ~* '^\\s*admin\\s*$'
      )
      AND u."emailVerified" IS TRUE
      AND (u.banned IS NOT TRUE OR u."banExpires" <= now())
    ORDER BY u.id FOR UPDATE OF u
    ) AS active_admins`);
  if ((admins.rows[0]?.count ?? 0) <= 1) {
    throw new ORPCError("FORBIDDEN", { data: { reason: "LAST_ACTIVE_ADMIN" } });
  }
  return target;
}

export function mapUserChangeConflict(error: unknown): void {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "P2034" || error.code === "40001")
  ) {
    throw new ORPCError("CONFLICT", { data: { reason: "USER_CHANGE_CONFLICT" } });
  }
}
