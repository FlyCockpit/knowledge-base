import { isAdminRole } from "@knowledge-base/auth/roles";
import { Button } from "@knowledge-base/ui/components/button";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, KeyRound } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import { PAGE_COLUMN_CLASS } from "@/components/page-shell";
import { useAuthSession } from "@/hooks/use-auth-session";
import { orpc } from "@/utils/orpc";

const BANNER_CLASS =
  "border-b border-yellow-300 bg-yellow-100 py-3 text-sm text-yellow-900 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-100";

/**
 * Admin-setup banners in the app shell.
 *
 * 1. A prominent warning when ADMIN_EMAIL is unset on the server and no
 *    administrator exists. A fresh production deploy cannot bootstrap its
 *    first admin without that identity, and the console-level warning is easy
 *    for nontechnical owners to miss. When the first account already became
 *    the admin (local bootstrap), nothing is wrong, so it stays hidden; the
 *    admin overview explains how that admin was chosen instead. Renders
 *    nothing while loading so it never flashes; query errors render a
 *    conservative warning because this check protects the bootstrap path.
 * 2. A reminder, to admins only, to remove SETUP_KEY once it has done its job.
 *    While it is set the first-admin setup route (apps/server/src/setup-routes.ts)
 *    stays mounted; it refuses once bootstrap is complete, but the key is still
 *    a live credential in the deploy's environment. Admin-only on both sides:
 *    the query is an admin procedure and is not even sent unless the session
 *    is a verified admin. Nothing while loading or on error: a reminder, not a
 *    gate.
 */
export function AdminSetupBanner() {
  const { t } = useTranslation("admin");
  // adminSetupStatus is a protectedProcedure — calling it while logged out
  // returns 401, which would render the error banner to every anonymous
  // visitor (it mounts in the app shell). Gate the query on a confirmed,
  // non-degraded authenticated session so the banner only ever shows to
  // logged-in users (its intended audience).
  const authSession = useAuthSession();
  const canCheckSetup =
    authSession.state.status === "authenticated" && !authSession.meta.isDegraded;
  const user = authSession.state.status === "authenticated" ? authSession.state.session.user : null;
  const isAdmin = canCheckSetup && user?.emailVerified === true && isAdminRole(user.role);
  // ADMIN_EMAIL and SETUP_KEY are server-restart-time constants, so refetching
  // on every route transition is wasteful. 5-minute staleTime avoids hammering
  // the API.
  const { data, isPending, isError, refetch } = useQuery({
    ...orpc.settings.adminSetupStatus.queryOptions(),
    enabled: canCheckSetup,
    staleTime: 5 * 60 * 1000,
  });
  const { data: setupKey } = useQuery({
    ...orpc.settings.setupKeyStatus.queryOptions(),
    enabled: isAdmin,
    staleTime: 5 * 60 * 1000,
  });

  if (authSession.state.status !== "authenticated") return null;

  const setupKeyReminder =
    isAdmin && setupKey?.setupKeySet ? (
      <div role="alert" className={BANNER_CLASS}>
        <div className={cn(PAGE_COLUMN_CLASS, "flex items-start gap-3")}>
          <KeyRound className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div className="min-w-0 flex-1 space-y-1 [&_p]:max-w-prose">
            <p className="font-medium">{t("setupKeyBanner.title")}</p>
            <p className="text-yellow-900/90 dark:text-yellow-100/90">
              <Trans
                i18nKey="setupKeyBanner.message"
                t={t}
                components={[<code key="0" className="font-mono" />]}
              />
            </p>
          </div>
        </div>
      </div>
    ) : null;

  if (isPending) return setupKeyReminder;
  if (isError) {
    return (
      <>
        <div role="alert" className={BANNER_CLASS}>
          <div className={cn(PAGE_COLUMN_CLASS, "flex flex-col gap-3 sm:flex-row sm:items-start")}>
            <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
            <div className="flex-1 space-y-1 [&_p]:max-w-prose">
              <p className="font-medium">{t("setupBanner.errorTitle")}</p>
              <p className="text-yellow-900/90 dark:text-yellow-100/90">
                {t("setupBanner.errorMessage")}
              </p>
            </div>
            <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => refetch()}>
              {t("setupBanner.retry")}
            </Button>
          </div>
        </div>
        {setupKeyReminder}
      </>
    );
  }
  if (!data?.adminEmailsEmpty || data.adminExists) return setupKeyReminder;

  return (
    <>
      <div role="alert" className={BANNER_CLASS}>
        <div className={cn(PAGE_COLUMN_CLASS, "flex items-start gap-3")}>
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div className="flex-1 space-y-1 [&_p]:max-w-prose">
            <p className="font-medium">{t("setupBanner.title")}</p>
            <p className="text-yellow-900/90 dark:text-yellow-100/90">
              <Trans
                i18nKey="setupBanner.message"
                t={t}
                components={[<code key="0" className="font-mono" />]}
              />
            </p>
          </div>
        </div>
      </div>
      {setupKeyReminder}
    </>
  );
}
