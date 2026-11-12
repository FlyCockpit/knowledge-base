import {
  mapAccountDeletionError,
  removeUserAccount,
} from "@knowledge-base/api/lib/kb/account-removal";
import { getKbRuntime } from "@knowledge-base/api/lib/kb/runtime";
import { runWithAllowedAccountDeletion } from "@knowledge-base/auth/account-deletion-policy";
import prisma from "@knowledge-base/db";
import { logInternalError } from "@knowledge-base/env/log";
import type { Context } from "hono";

import { requireVerifiedAdminSession } from "./admin-session-gate";
import { validateSameSiteJsonRequest } from "./request-origin.js";

// Better Auth's `/admin/remove-user` deletes the target's sessions, then
// accounts, then the user — non-transactionally, and its only hook seam
// (`user.delete.before`) fires after the credential rows are already gone.
// A removal this app blocks (owned ACTIVE KBs) must not destroy the target's
// login credentials on the way out, so this route is served here instead of
// by the plugin and funnels the entire deletion through the shared
// transactional policy BEFORE any credential deletion. The adapter-level
// guards in `packages/auth/src/bootstrap.ts` stay as defense in depth for
// programmatic `internalAdapter.deleteUser` callers.
export async function betterAuthRemoveUser(c: Context) {
  // Serving this route here bypasses Better Auth's handler — and with it the
  // origin-check middleware Better Auth installs on every request it serves.
  // The session cookie is SameSite=None in cross-origin deployments, so a
  // forged cross-site simple request (text/plain form/fetch) carrying a
  // JSON-parseable body is a real threat on this destructive endpoint. Same
  // guard as /sw/push-renew: JSON-only body, same-site fetch metadata, Origin
  // allowlist — before anything touches the session or the policy.
  const rejected = validateSameSiteJsonRequest(c);
  if (rejected) return rejected;

  const gate = await requireVerifiedAdminSession(c.req.raw.headers);
  if (!gate.ok) {
    return c.json({ error: gate.error, error_description: gate.errorDescription }, gate.status);
  }

  let userId: unknown;
  try {
    userId = (await c.req.json())?.userId;
  } catch {
    userId = undefined;
  }
  if (typeof userId !== "string" || userId.length === 0) {
    return c.json({ error: "bad_request", error_description: "userId is required" }, 400);
  }
  if (userId === gate.session.user.id) {
    return c.json({ error: "bad_request", error_description: "You cannot remove yourself." }, 400);
  }

  const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!target) {
    return c.json({ error: "not_found", error_description: "User not found" }, 404);
  }

  try {
    await runWithAllowedAccountDeletion("ordinary", () =>
      removeUserAccount(getKbRuntime(), userId, { actingUserId: gate.session.user.id }),
    );
  } catch (error) {
    const mapped = mapAccountDeletionError(error);
    if (mapped) {
      return c.json({ error: "conflict", error_description: mapped.message }, 409);
    }
    logInternalError("admin.remove-user", error);
    return c.json(
      { error: "server_error", error_description: "Couldn't delete that account." },
      500,
    );
  }
  return c.json({ success: true });
}
