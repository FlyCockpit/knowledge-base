import { randomUUID } from "node:crypto";
import { auth } from "@knowledge-base/auth";
import { runWithAllowedAccountDeletion } from "@knowledge-base/auth/account-deletion-policy";
import {
  recordTwoFactorGraceStartForRoleChange,
  revokeUserMcpGrants,
  withOutgoingTwoFactorMcpSettlement,
} from "@knowledge-base/auth/ban";
import {
  mintSetPasswordLink,
  recordResetLinkProof,
  SetPasswordLinkRefusedError,
} from "@knowledge-base/auth/password-reset-links";
import { runWithAdminMutationActor } from "@knowledge-base/auth/session-authority";
import { runWithAllowedUserCreation } from "@knowledge-base/auth/user-creation-policy";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  SUPPORTED_LOCALES,
} from "@knowledge-base/config/locales";
import prisma, { type Prisma } from "@knowledge-base/db";
import { logInternalError } from "@knowledge-base/env/log";
import { env } from "@knowledge-base/env/server";
import { isEmailConfigured, renderInviteUser, sendEmail } from "@knowledge-base/mailer";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { adminOr404Procedure, liveAdminOr404Procedure } from "../index";
import { assertAdminRemovalAllowed, mapUserChangeConflict } from "../lib/admin-presence";
import { mapAccountDeletionError, removeUserAccount } from "../lib/kb/account-removal";
import { prismaAssetQuery } from "../lib/kb/asset-authz";
import { recordAuditEvent } from "../lib/kb/audit";
import { getKbRuntime } from "../lib/kb/runtime";
import { cursorPage, cursorPageInput, pageTake, withCursor } from "../lib/pagination";

// Roles surfaced in the admin UI. Better-auth itself stores `role` as a free-
// form string (and supports comma-separated lists), but the admin dashboard
// only ever assigns one of these two — anything else came from custom code or
// a database edit and we leave it untouched.
const ASSIGNABLE_ROLES = ["user", "admin"] as const;
const assignableRoleSchema = z.enum(ASSIGNABLE_ROLES);

const userIdInput = z.object({ userId: z.string().min(1) });

const userStatusFilter = z.enum(["all", "active", "archived"]);

/** How long an invitation's set-password link stays usable. */
const INVITE_SET_PASSWORD_TTL_MS = 72 * 60 * 60 * 1000;

/**
 * Mint the invitee's one-time set-password link: a Better Auth password-reset
 * token (`reset-password:<token>` → userId, exactly like
 * `requestPasswordReset`), minted under the per-user credential-setup lock
 * while the account is still a pending invite
 * (@knowledge-base/auth/password-reset-links `mintSetPasswordLink`), and the
 * link that leads to the localized page redeeming it. Better Auth's
 * `/reset-password` consumes the token in the same transaction as the
 * password write, so the link works once.
 *
 * The row is written in Better Auth 1.7's own format directly (the internal
 * adapter cannot join a Prisma transaction). That format holds only while the
 * identifier is stored in plain text and verification rows live in Postgres
 * (no `verification.storeIdentifier`, no `secondaryStorage`); both are checked
 * here so a config change fails loudly instead of minting dead links.
 */
async function createInviteSetPasswordUrl(
  userId: string,
  locale: string,
  noSmtpInviteFor: string | undefined,
): Promise<{ url: string; token: string }> {
  const context = await auth.$context;
  // Widened on purpose: today's config sets neither key.
  const options: Record<string, unknown> = { ...context.options };
  const verification = options.verification;
  const transformsIdentifier =
    typeof verification === "object" &&
    verification !== null &&
    "storeIdentifier" in verification &&
    verification.storeIdentifier !== undefined;
  if (transformsIdentifier || options.secondaryStorage !== undefined) {
    throw new Error(
      "The invite link writes plain-identifier verification rows to Postgres; update it for the new Better Auth verification storage config.",
    );
  }
  const { token } = await mintSetPasswordLink({
    userId,
    ttlMs: INVITE_SET_PASSWORD_TTL_MS,
    noSmtpInviteFor,
  });
  const lang = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
  // The localized page the link lands on. Better Auth's GET endpoint checks
  // the token first and appends it (or `?error=INVALID_TOKEN` for a used or
  // expired link), exactly like an ordinary reset mail.
  const landing = new URL(`/${lang}/reset-password`, env.CORS_ORIGIN || env.BETTER_AUTH_URL);
  landing.searchParams.set("invite", "1");
  const url = new URL(`/api/auth/reset-password/${token}`, env.BETTER_AUTH_URL);
  url.searchParams.set("callbackURL", landing.toString());
  return { url: url.toString(), token };
}

/**
 * Record that the invite link was mailed, so spending it proves the
 * address; a failure is logged, never surfaced (the invite stands; the
 * invitee then confirms the address through the mail sign-in sends them).
 */
async function recordMailedInviteLink(
  link: { token: string },
  userId: string,
  email: string,
): Promise<void> {
  try {
    await recordResetLinkProof({ token: link.token, userId, email, proof: "mailbox" });
  } catch (err) {
    logInternalError("users.invite-link-proof", err);
  }
}

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  emailVerified: true,
  banned: true,
  banReason: true,
  banExpires: true,
  twoFactorEnabled: true,
  image: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const usersRouter = {
  list: adminOr404Procedure
    .input(
      cursorPageInput
        .extend({
          limit: z.number().int().min(1).max(100).default(50),
          search: z.string().trim().max(200).optional(),
          status: userStatusFilter.default("all"),
        })
        .optional(),
    )
    .handler(async ({ input }) => {
      const limit = input?.limit ?? 50;
      const cursor = input?.cursor;
      const search = input?.search;
      const status = input?.status ?? "all";
      // Status is filtered in the database, not on the client: filtering
      // already-paginated pages makes both the empty state and the "load more"
      // affordance lie (an all-archived first page under the "active" tab would
      // look empty even though later pages hold active users). `banned` is a
      // nullable Boolean, so "active" must match both `false` and NULL.
      const searchWhere: Prisma.UserWhereInput | undefined = search
        ? {
            OR: [
              { email: { contains: search, mode: "insensitive" as const } },
              { name: { contains: search, mode: "insensitive" as const } },
            ],
          }
        : undefined;
      const statusWhere: Prisma.UserWhereInput | undefined =
        status === "active"
          ? { OR: [{ banned: false }, { banned: null }] }
          : status === "archived"
            ? { banned: true }
            : undefined;
      // Narrowed (not just filtered): `withCursor` ANDs this into an array,
      // where an `undefined` union member would fail typecheck.
      const conditions = [statusWhere, searchWhere].filter(
        (c): c is Prisma.UserWhereInput => c !== undefined,
      );
      const where: Prisma.UserWhereInput =
        conditions.length > 1 ? { AND: conditions } : (conditions[0] ?? {});
      // Cursor (keyset) pagination: no `skip` scan, no per-page `count()`.
      // The admin UI consumes this as an infinite list (LoadMore), so the
      // header total is dropped — it cost a full filtered count per page for
      // a "showing N" nicety. Tie-break on the unique id: `createdAt` alone
      // is not a stable sort key, so two users created in the same
      // millisecond could repeat or vanish across pages.
      const rows = await prisma.user.findMany({
        // The status/search `where` stays the first `AND` member; the keyset
        // narrows it, it never replaces it.
        where: withCursor(where, "createdAt", cursor, "desc"),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: pageTake(limit),
        select: USER_SELECT,
      });
      const page = cursorPage(rows, limit, "createdAt");
      return { users: page.items, nextCursor: page.nextCursor };
    }),

  invite: adminOr404Procedure
    .input(
      z.object({
        email: z.string().email().toLowerCase(),
        name: z.string().trim().min(1).max(100),
        role: assignableRoleSchema.default("user"),
        // The invitee's language: the invite email, the set-password page it
        // links to, and every later email use it, and it is saved as their
        // `User.locale` (they can change it in settings). The admin UI
        // defaults it to the admin's own language.
        locale: z.enum(SUPPORTED_LOCALES),
      }),
    )
    .handler(async ({ input, context }) => {
      // `auth.api.createUser` is the only admin-plugin endpoint that accepts
      // server-side calls without a session in headers (verified in the
      // better-auth source). It enforces email uniqueness and writes through
      // the Prisma adapter so it stays in sync with any custom databaseHooks
      // and the bootstrap adapter wrap. No password: the account gets a
      // credential only when the invitee sets one through the emailed link.
      //
      // The account starts unverified, and the invite email is the only mail:
      // createUser sends no verification mail, and sign-in's resend
      // (`sendOnSignIn`) needs a password, which the account does not have
      // until the link is spent. Spending a MAILED link proves the inbox and
      // marks the email verified then (@knowledge-base/auth/password-reset-links).
      // A link shown to the admin because the mail failed only sets the
      // password; sign-in then mails the invitee a verification link. So an
      // invite to a mistyped address never yields a verified account on a
      // server that can send mail. On a server with no SMTP at all, the shown
      // link is the documented private invitation and the admin's invite
      // vouches for the address (docs/access-matrix.md).
      let userId: string;
      try {
        // The grant's locale seeds `User.locale` in the user-create hook
        // (packages/auth): a server-side createUser carries no locale header.
        const created = await runWithAdminMutationActor(context.session.user.id, () =>
          runWithAllowedUserCreation(
            "admin-invite",
            () =>
              auth.api.createUser({
                body: {
                  email: input.email,
                  name: input.name,
                  role: input.role,
                },
              }),
            { locale: input.locale },
          ),
        );
        userId = created.user.id;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to invite user";
        if (/already exists|already in use|duplicate/i.test(message)) {
          throw new ORPCError("CONFLICT", {
            message: "A user with that email already exists.",
          });
        }
        if (/sign-?up.*disabled|disabled.*sign-?up/i.test(message)) {
          throw new ORPCError("BAD_REQUEST", {
            message:
              "Account creation is disabled by the auth configuration. Ask an admin to check the invite setup.",
          });
        }
        // Log only name+message, never the raw error object, in case a future
        // better-auth release attaches request context to thrown errors.
        logInternalError("users.invite", err);
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message:
            "Couldn't create that account. Try again, or contact an admin if it keeps happening.",
        });
      }

      // A one-time "set your password" link. It is Better Auth's own
      // password-reset token (single use, consumed with the password write),
      // with a longer expiry. Localized `/$lang/` URL.
      // On a server with no SMTP at all (no SMTP_HOST) the shown link is the
      // private invitation, and the invite vouches for the address: that
      // proof is written with the link (docs/access-matrix.md). A half
      // configuration (a host without a sender) is a broken SMTP setup, not
      // "no SMTP": no proof, and the invitee confirms the address by mail.
      const smtpConfigured = isEmailConfigured();
      const noSmtp = !env.SMTP_HOST;
      let link: { url: string; token: string };
      try {
        link = await createInviteSetPasswordUrl(
          userId,
          input.locale,
          noSmtp ? input.email : undefined,
        );
      } catch (err) {
        if (err instanceof SetPasswordLinkRefusedError) {
          throw new ORPCError("CONFLICT", {
            message: "That account is already in use, so no invite link was created.",
          });
        }
        throw err;
      }
      const setPasswordUrl = link.url;

      // Email send is best-effort: if SMTP is not configured (or fails) the
      // admin gets the link to hand over out of band. The failure is logged
      // but does not roll back the user creation — undoing it would race
      // against any concurrent admin who is already looking at the new row.
      let emailSent = false;
      if (smtpConfigured) {
        try {
          const { subject, html } = renderInviteUser({
            name: input.name,
            email: input.email,
            setPasswordUrl,
            expiresInHours: INVITE_SET_PASSWORD_TTL_MS / 3_600_000,
            locale: input.locale,
          });
          await sendEmail({ to: input.email, subject, html });
          emailSent = true;
        } catch (err) {
          logInternalError("users.invite-email", err);
        }
      }

      if (emailSent) {
        // Mailed: spending it proves the inbox. Never hand the admin the link
        // after the mail went out.
        await recordMailedInviteLink(link, userId, input.email);
        return { userId, emailSent };
      }
      // SMTP configured but the send failed: no proof; the invitee confirms
      // the address at first sign-in.
      return {
        userId,
        emailSent,
        setPasswordUrl,
        confirmsEmailAtSignIn: !noSmtp,
      };
    }),

  setRole: liveAdminOr404Procedure
    .input(
      z.object({
        userId: z.string().min(1),
        role: assignableRoleSchema,
      }),
    )
    .handler(async ({ input, context }) => {
      // Don't let an admin demote themselves — if they're the only admin
      // they'd lock themselves (and everyone) out of /admin.
      if (input.userId === context.session.user.id && input.role !== "admin") {
        throw new ORPCError("FORBIDDEN", {
          message: "You cannot remove your own admin role.",
          data: { reason: "SELF_DEMOTION" },
        });
      }
      const tx = context.authorityTx;
      const target = await assertAdminRemovalAllowed(
        prismaAssetQuery(tx),
        input.userId,
        input.role,
      );
      const exec = (sql: string, params: unknown[]) => tx.$executeRawUnsafe(sql, ...params);
      await withOutgoingTwoFactorMcpSettlement(exec, input.userId, async () => {
        // A promotion that brings the user under forced 2FA starts their
        // enrollment grace now, not at account creation.
        await recordTwoFactorGraceStartForRoleChange(exec, input.userId, input.role);
        return tx.user.update({ where: { id: input.userId }, data: { role: input.role } });
      });
      if (target.role !== input.role)
        await recordAuditEvent(prismaAssetQuery(tx), {
          opId: randomUUID(),
          action: "users.role_changed",
          outcome: "SUCCESS",
          actorKey: `user:${context.session.user.id}`,
          actorUserId: context.session.user.id,
          actorUserIdSnapshot: context.session.user.id,
          metadata: { shareUserId: input.userId, before: target.role ?? "", after: input.role },
        });
      return { success: true };
    }),

  archive: liveAdminOr404Procedure
    .input(
      z.object({
        userId: z.string().min(1),
        reason: z.string().trim().max(500).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      if (input.userId === context.session.user.id) {
        throw new ORPCError("FORBIDDEN", {
          message: "You cannot archive your own account.",
        });
      }
      const tx = context.authorityTx;
      await assertAdminRemovalAllowed(prismaAssetQuery(tx), input.userId);

      // Set banned=true so better-auth treats the user as locked, and revoke
      // every active session so the next page-load signs them out. We mirror
      // what the admin plugin's banUser endpoint does internally — no expiry
      // (banExpires=null), no auto-unban.
      //
      // If you add a standing credential that authenticates from its own row
      // (an API key, a personal access token), revoke it here too: deleting
      // sessions does not touch it, so it would outlive the ban everywhere a
      // per-surface ban re-check does not reach.
      await tx.user.update({
        where: { id: input.userId },
        data: {
          banned: true,
          banReason: input.reason ?? null,
          banExpires: null,
        },
      });
      await tx.session.deleteMany({ where: { userId: input.userId } });
      // Standing MCP credentials authenticate from their own rows: tombstone
      // every grant generation (and PAT) in this same authority-locked
      // transaction. Unarchive never clears these tombstones.
      await revokeUserMcpGrants(
        (sql, params) => tx.$executeRawUnsafe(sql, ...params),
        input.userId,
        "ban",
      );

      return { success: true };
    }),

  unarchive: liveAdminOr404Procedure.input(userIdInput).handler(async ({ input, context }) => {
    const target = await context.authorityTx.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!target) throw new ORPCError("NOT_FOUND", { message: "User not found" });

    // Lifts the ban only. MCP grants/PATs revoked by `archive` stay
    // tombstoned (a fresh generation must be minted). Do NOT flip a revoked
    // credential back on from here: the row records that a
    // credential IS revoked, not who revoked it, so a blanket re-enable would
    // also resurrect one an admin had deliberately killed earlier (a leaked
    // key, a decommissioned integration). Restoring precisely needs a column
    // recording that archive was the revoker.
    const tx = context.authorityTx;
    await tx.user.update({
      where: { id: input.userId },
      data: { banned: false, banReason: null, banExpires: null },
    });

    return { success: true };
  }),

  remove: adminOr404Procedure.input(userIdInput).handler(async ({ input, context }) => {
    if (input.userId === context.session.user.id) {
      throw new ORPCError("FORBIDDEN", {
        message: "You cannot delete your own account.",
      });
    }
    const target = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!target) throw new ORPCError("NOT_FOUND", { message: "User not found" });

    try {
      const runtime = getKbRuntime();
      await runWithAllowedAccountDeletion("ordinary", () =>
        removeUserAccount(runtime, input.userId, { actingUserId: context.session.user.id }),
      );
    } catch (err) {
      if (err instanceof ORPCError) throw err;
      mapUserChangeConflict(err);
      const mapped = mapAccountDeletionError(err);
      if (mapped) {
        throw new ORPCError("CONFLICT", { message: mapped.message });
      }
      const message = err instanceof Error ? err.message : "Failed to delete user";
      if (/foreign key|constraint|restrict/i.test(message)) {
        throw new ORPCError("CONFLICT", {
          message:
            "This user has authored content and cannot be deleted. Archive them instead, or reassign their content first.",
        });
      }
      logInternalError("users.remove", err);
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message:
          "Couldn't delete that account. Try again, or contact an admin if it keeps happening.",
      });
    }
    return { success: true };
  }),

  removeForce: adminOr404Procedure.input(userIdInput).handler(async ({ input, context }) => {
    if (input.userId === context.session.user.id) {
      throw new ORPCError("FORBIDDEN", {
        message: "You cannot delete your own account.",
      });
    }
    const target = await prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true },
    });
    if (!target) throw new ORPCError("NOT_FOUND", { message: "User not found" });

    try {
      const runtime = getKbRuntime();
      await runWithAllowedAccountDeletion("admin-force", () =>
        removeUserAccount(runtime, input.userId, { actingUserId: context.session.user.id }),
      );
    } catch (err) {
      if (err instanceof ORPCError) throw err;
      mapUserChangeConflict(err);
      const mapped = mapAccountDeletionError(err);
      if (mapped) {
        throw new ORPCError("CONFLICT", { message: mapped.message });
      }
      const message = err instanceof Error ? err.message : "Failed to delete user";
      if (/foreign key|constraint|restrict/i.test(message)) {
        throw new ORPCError("CONFLICT", {
          message:
            "This user has authored content and cannot be deleted. Archive them instead, or reassign their content first.",
        });
      }
      logInternalError("users.remove", err, { stage: "force" });
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message:
          "Couldn't delete that account. Try again, or contact an admin if it keeps happening.",
      });
    }
    return { success: true };
  }),
};
