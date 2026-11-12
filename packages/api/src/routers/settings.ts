import {
  recordTwoFactorGraceStartForPolicyActivation,
  withOutgoingTwoFactorMcpSettlement,
} from "@knowledge-base/auth/ban";
import { isAdminRole } from "@knowledge-base/auth/roles";
import { isForcedTwoFactorActivation } from "@knowledge-base/auth/two-factor-policy";
import prisma from "@knowledge-base/db";
import { ADMIN_EMAIL } from "@knowledge-base/env/server";
import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { authenticatedProcedure, liveAdminOr404Procedure } from "../index";
import { FORCE_2FA_SETTING_KEYS } from "../lib/two-factor-policy";

// Leak-prevention boundary: only keys listed here are exposed to clients via getAll; future settings must be explicitly opted in.
const CLIENT_READABLE_SETTING_KEYS: readonly string[] = FORCE_2FA_SETTING_KEYS;
const writableSettingKeySchema = z.enum(FORCE_2FA_SETTING_KEYS);
/** Rows whose role merely contains "admin" (e.g. a custom role) are filtered by `isAdminRole`. */
const ADMIN_PROBE_ROWS = 20;

export const settingsRouter = {
  getAll: authenticatedProcedure.handler(async () => {
    const settings = await prisma.appSetting.findMany({
      where: { key: { in: [...CLIENT_READABLE_SETTING_KEYS] } },
      // pagination:audited — bounded by the compile-time settings key list
      take: CLIENT_READABLE_SETTING_KEYS.length,
      select: { key: true, value: true },
    });
    return Object.fromEntries(settings.map((s) => [s.key, s.value]));
  }),

  /**
   * Returns admin-setup status so the client can render a prominent warning
   * banner when ADMIN_EMAIL is unset and no administrator exists yet. Without
   * ADMIN_EMAIL, a non-production instance makes its first account the admin,
   * so `adminExists` tells "nobody can administer this" apart from "the first
   * account became admin". Authenticated so the banner only shows to logged-in
   * users; it discloses one boolean, never who the admin is.
   */
  adminSetupStatus: authenticatedProcedure.handler(async () => {
    const adminEmailsEmpty = ADMIN_EMAIL === undefined;
    if (!adminEmailsEmpty) return { adminEmailsEmpty, adminExists: true };
    const candidates = await prisma.user.findMany({
      where: {
        role: { contains: "admin", mode: "insensitive" },
        OR: [{ banned: null }, { banned: false }],
      },
      // pagination:audited — an existence probe; a few rows settle it
      take: ADMIN_PROBE_ROWS,
      select: { role: true },
    });
    return { adminEmailsEmpty, adminExists: candidates.some((user) => isAdminRole(user.role)) };
  }),

  myNotificationPreferences: authenticatedProcedure.handler(async ({ context }) => {
    const user = await prisma.user.findUnique({
      where: { id: context.session.user.id },
      select: { operationalAlerts: true },
    });
    return {
      operationalAlerts: user?.operationalAlerts ?? true,
    };
  }),

  updateMyNotificationPreferences: authenticatedProcedure
    .input(
      z.object({
        operationalAlerts: z.boolean(),
      }),
    )
    .handler(async ({ input, context }) => {
      await prisma.user.update({
        where: { id: context.session.user.id },
        data: { operationalAlerts: input.operationalAlerts },
      });
      return { success: true };
    }),

  update: liveAdminOr404Procedure
    .input(
      z.object({
        key: writableSettingKeySchema,
        value: z.enum(["true", "false"]),
      }),
    )
    .handler(async ({ input, context }) => {
      // Strict by design: an admin must secure their own account before
      // requiring 2FA for either public users or internal/admin users.
      if (input.value === "true") {
        if (!context.liveAdmin.twoFactorEnabled) {
          throw new ORPCError("FORBIDDEN", {
            message: "You must enable 2FA for your own account before requiring it for others",
          });
        }
      }

      const tx = context.authorityTx;
      const exec = (sql: string, params: unknown[]) => tx.$executeRawUnsafe(sql, ...params);
      await withOutgoingTwoFactorMcpSettlement(exec, null, async () => {
        const before = await tx.appSetting.findUnique({
          where: { key: input.key },
          select: { value: true },
        });
        const written = await tx.appSetting.upsert({
          where: { key: input.key },
          update: { value: input.value },
          create: { key: input.key, value: input.value },
        });
        // Turning the policy on (or widening it to this population)
        // starts the enrollment grace now for everyone it newly covers.
        if (isForcedTwoFactorActivation(input.key, before?.value, input.value)) {
          await recordTwoFactorGraceStartForPolicyActivation(exec, input.key);
        }
        return written;
      });

      return { success: true };
    }),
};
