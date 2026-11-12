import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { AuthCard } from "@/components/auth/auth-screen";
import { ResendVerification } from "@/components/auth/resend-verification";
import { useAuthSession } from "@/hooks/use-auth-session";
import { pageHead } from "@/lib/page-title";
import { parseVerifyEmailSearch } from "@/lib/verify-email-search";
import { orpc } from "@/utils/orpc";

/**
 * Landing page for the link in the account-verification email.
 *
 * The user does not arrive here directly: the emailed link points at
 * Better-Auth's `/api/auth/verify-email`, which validates the signed token,
 * flips `emailVerified`, and only then 302s here — carrying the `?ok=1` marker
 * `packages/auth` put on the callbackURL, plus `&error=<CODE>` when the token
 * was expired, malformed, or belongs to a user that no longer exists. So this
 * page never sees or handles a token, and there is nothing here an attacker
 * could replay.
 *
 * Three states, because this route is unguarded and directly navigable:
 *   • `?error=` → the link failed; offer a resend.
 *   • `?ok=1`   → came through a real verification hop; confirm it.
 *   • neither   → someone navigated here on their own (bookmark, back button,
 *     a guard bouncing an unverified user). We know nothing about their state, so
 *     we say so and offer a resend. Inferring success from the mere absence of
 *     `?error=` would tell an unverified user their address is confirmed and
 *     then bounce them at the login form.
 *
 * Verification deliberately does not create a session (Better-Auth's
 * `autoSignInAfterVerification` is left at its default `false`), so a forwarded
 * or leaked link can confirm an address but never hand out an account. The
 * success state therefore routes to sign-in — unless the visitor already has a
 * session, in which case we send them onward instead of bouncing them through a
 * login form they don't need.
 *
 * Unlike its siblings this route has no `beforeLoad` guard: it is a terminal
 * landing page that has to render for signed-out and signed-in visitors alike,
 * and an anonymous-only redirect would break the second case.
 */
export const Route = createFileRoute("/$lang/_app/verify-email")({
  validateSearch: parseVerifyEmailSearch,
  head: ({ match }) => pageHead(match.context.i18n.t("nav:titles.verifyEmail")),
  // Defined in `lib/verify-email-search.ts` so it can be tested against the
  // router's real search parser — see that file for why the marker check has to
  // be permissive.
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  const { lang } = Route.useParams();
  const { error, ok } = Route.useSearch();
  const authSession = useAuthSession();
  const {
    data: configData,
    isPending: configPending,
    isError: configError,
    refetch: refetchConfig,
  } = useQuery(orpc.appConfig.queryOptions());
  const { t } = useTranslation(["auth", "common"]);

  const isAuthenticated = authSession.state.status === "authenticated";
  // Resending needs a working mail transport and a password flow to come back
  // to; an SSO-only server has neither. Failing quiet here is better than
  // offering a button that can only ever produce a server-side error.
  const canResend = configData?.emailEnabled === true && configData?.forceSso !== true;

  // `error` wins over `ok`: a failed hop arrives as `?ok=1&error=<CODE>`,
  // since Better-Auth appends its code to the callbackURL we already built.
  if (error || !ok) {
    return (
      <AuthCard
        title={error ? t("auth:verifyEmail.invalidTitle") : t("auth:verifyEmail.pendingTitle")}
        description={
          error
            ? t("auth:verifyEmail.invalidDescription")
            : t("auth:verifyEmail.pendingDescription")
        }
      >
        {configPending ? (
          <Skeleton className="h-10 w-full" />
        ) : configError ? (
          // Without this branch a transient fetch failure leaves `configData`
          // undefined, so `canResend` is false and the user is told email is
          // unconfigured — a wrong diagnosis with no way out. Offer the retry
          // instead, as login.tsx and signup.tsx do.
          <div className="space-y-2 text-center">
            <p className="text-sm text-muted-foreground">
              {t("auth:login.unableToConnectDescription")}
            </p>
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px] w-full"
              onClick={() => refetchConfig()}
            >
              {t("common:actions.retry")}
            </Button>
          </div>
        ) : canResend ? (
          <ResendVerification />
        ) : (
          <p className="text-center text-sm text-muted-foreground">
            {t("auth:verifyEmail.emailUnavailable")}
          </p>
        )}
        <div className="text-center">
          <Link
            to="/$lang/login"
            params={{ lang }}
            search={{ redirectTo: undefined }}
            className={cn(buttonVariants({ variant: "link" }), "min-h-[44px]")}
          >
            {t("auth:verifyEmail.backToLogin")}
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t("auth:verifyEmail.successTitle")}
      description={
        isAuthenticated
          ? t("auth:verifyEmail.successDescriptionSignedIn")
          : t("auth:verifyEmail.successDescription")
      }
    >
      {isAuthenticated ? (
        <Link
          to="/$lang/dashboard"
          params={{ lang }}
          className={cn(buttonVariants(), "min-h-[44px] w-full")}
        >
          {t("auth:verifyEmail.continue")}
        </Link>
      ) : (
        <Link
          to="/$lang/login"
          params={{ lang }}
          search={{ redirectTo: undefined }}
          className={cn(buttonVariants(), "min-h-[44px] w-full")}
        >
          {t("auth:verifyEmail.signIn")}
        </Link>
      )}
    </AuthCard>
  );
}
