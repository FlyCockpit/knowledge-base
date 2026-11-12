import { buttonVariants } from "@knowledge-base/ui/components/button";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAuthSession } from "@/hooks/use-auth-session";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { orpc } from "@/utils/orpc";
import { formatRelativeTime } from "@/utils/relative-time";
import { twoFactorEnrollmentState } from "@/utils/two-factor-policy";

/**
 * Nudges a signed-in admin who has not enrolled a TOTP second factor.
 *
 * Enrollment is REQUIRED for admins unless the owner has explicitly turned
 * `force2faInternalUsers` off, so this banner has three voices:
 *   - inside the enrollment grace window → required, with the deadline;
 *   - past it → the gates are already rejecting them, say so;
 *   - enforcement explicitly disabled → the original advisory nudge.
 * It always names where the policy is configured, because the owner reading
 * this banner is usually the person who can change it.
 *
 * Links to the existing /settings/security enrollment flow rather than
 * duplicating it. Rendered by the admin layout; renders nothing until the
 * session and settings resolve, so it never flashes the wrong copy.
 *
 * `audience="account"` is the `_auth` layout's variant for EVERY user the
 * policy covers: it only speaks during the grace window, with the
 * deadline — past it the layout's enrollment takeover replaces the page, and
 * an unforced user is not nagged outside the admin dashboard.
 */
export function TwoFactorNudge({ audience = "admin" }: { audience?: "admin" | "account" }) {
  const { t, i18n } = useTranslation(["admin", "auth"]);
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  const authSession = useAuthSession();
  const { data: appSettings } = useQuery(orpc.settings.getAll.queryOptions());

  if (authSession.state.status !== "authenticated") return null;
  const user = authSession.state.session.user;
  if (user.twoFactorEnabled === true) return null;
  if (!appSettings) return null;

  const enrollment = twoFactorEnrollmentState(appSettings, user);
  if (enrollment.status === "enrolled") return null;
  if (audience === "account" && enrollment.status !== "grace") return null;

  const deadline =
    enrollment.status === "grace"
      ? formatRelativeTime(enrollment.deadlineMs, i18n.language)
      : undefined;
  const title =
    audience === "account"
      ? t("auth:twoFactor.graceTitle")
      : enrollment.status === "grace"
        ? t("admin:twoFactorNudge.requiredTitle")
        : enrollment.status === "blocked"
          ? t("admin:twoFactorNudge.blockedTitle")
          : t("admin:twoFactorNudge.title");
  const message =
    audience === "account"
      ? t("auth:twoFactor.graceMessage", { deadline })
      : enrollment.status === "grace"
        ? t("admin:twoFactorNudge.requiredMessage", { deadline })
        : enrollment.status === "blocked"
          ? t("admin:twoFactorNudge.blockedMessage")
          : t("admin:twoFactorNudge.message");

  return (
    <div
      role="alert"
      className="border-b border-yellow-300 bg-yellow-100 px-4 py-3 text-sm text-yellow-900 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-100"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <ShieldAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="flex-1 space-y-1">
          <p className="font-medium">{title}</p>
          <p className="text-yellow-900/90 dark:text-yellow-100/90">{message}</p>
          {audience === "admin" && (
            <p className="text-yellow-900/80 dark:text-yellow-100/80">
              {t("admin:twoFactorNudge.configurable")}
            </p>
          )}
        </div>
        <Link
          to="/$lang/settings/security"
          params={{ lang }}
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "min-h-[44px]")}
        >
          {t("admin:twoFactorNudge.cta")}
        </Link>
      </div>
    </div>
  );
}
