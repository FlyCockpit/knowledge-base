import { Button } from "@knowledge-base/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import { useAuthSession } from "@/hooks/use-auth-session";
import { orpc } from "@/utils/orpc";

/**
 * Renders a prominent warning when ADMIN_EMAIL is unset on the server and no
 * administrator exists. A fresh production deploy cannot bootstrap its first
 * admin without that identity, and the existing console-level warning is easy
 * for nontechnical owners to miss. When the first account already became the
 * admin (local bootstrap), nothing is wrong, so the banner stays hidden; the
 * admin overview explains how that admin was chosen instead.
 *
 * Renders nothing while loading so it never flashes during pending state.
 * Query errors render a conservative warning because this check protects the
 * admin bootstrap path.
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
  // ADMIN_EMAIL is a server-restart-time constant, so refetching on every
  // route transition is wasteful. 5-minute staleTime avoids hammering the API.
  const { data, isPending, isError, refetch } = useQuery({
    ...orpc.settings.adminSetupStatus.queryOptions(),
    enabled: canCheckSetup,
    staleTime: 5 * 60 * 1000,
  });

  if (authSession.state.status !== "authenticated") return null;
  if (isPending) return null;
  if (isError) {
    return (
      <div
        role="alert"
        className="border-b border-yellow-300 bg-yellow-100 px-4 py-3 text-sm text-yellow-900 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-100"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div className="flex-1 space-y-1">
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
    );
  }
  if (!data?.adminEmailsEmpty || data.adminExists) return null;

  return (
    <div
      role="alert"
      className="border-b border-yellow-300 bg-yellow-100 px-4 py-3 text-sm text-yellow-900 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-100"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="flex-1 space-y-1">
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
  );
}
