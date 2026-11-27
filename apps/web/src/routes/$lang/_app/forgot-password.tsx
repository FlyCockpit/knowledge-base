import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import { toast } from "@knowledge-base/ui/components/sileo";
import { TextField } from "@knowledge-base/ui/components/text-field";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { AuthConfigGate } from "@/components/auth/auth-config-gate";
import { AuthCard } from "@/components/auth/auth-screen";
import { useAuthSession } from "@/hooks/use-auth-session";
import { useRedirectWhenAuthenticated } from "@/hooks/use-redirect-when-authenticated";
import { authClient } from "@/lib/auth-client";
import { markAnonymousOnlyRoute } from "@/lib/document-identity";
import { pageHead } from "@/lib/page-title";
import { ensureRouteQuery } from "@/lib/route-query";
import { resolveRouteSession } from "@/lib/route-session";
import { decideAnonymousOnlyRouteAccess } from "@/lib/route-session-access";
import { friendly, isRateLimit } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";
import { safeRedirectTo } from "@/utils/safe-redirect";

export const Route = createFileRoute("/$lang/_app/forgot-password")({
  staticData: { pendingShape: "auth" },
  validateSearch: (search: Record<string, unknown>) => ({
    redirectTo: typeof search.redirectTo === "string" ? search.redirectTo : undefined,
  }),
  beforeLoad: async ({ context, params, search }) => {
    const decision = decideAnonymousOnlyRouteAccess(await resolveRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-authenticated") {
      throw redirect({ href: safeRedirectTo(search.redirectTo, params.lang) });
    }
    // Password reset relies on email delivery and email/password sign-in. When
    // the org is SSO-only or SMTP isn't configured, there is no reset flow —
    // deflect to login exactly like signup deflects on forceSso.
    const cfg = await ensureRouteQuery(context.queryClient, orpc.appConfig.queryKey(), () =>
      orpc.appConfig.call(),
    );
    if (cfg.forceSso || !cfg.emailEnabled) {
      throw redirect({ to: "/$lang/login", params: { lang: params.lang }, search });
    }
  },
  head: ({ match }) => pageHead(match.context.i18n.t("nav:titles.forgotPassword")),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  markAnonymousOnlyRoute();
  // A peer tab's sign-in replaces this page instead of putting that account in the
  // header above the form (lib/document-identity.ts).
  const { lang } = Route.useParams();
  const { redirectTo } = Route.useSearch();
  const authSession = useAuthSession();
  useRedirectWhenAuthenticated({
    status: authSession.state.status,
    href: safeRedirectTo(redirectTo, lang),
    enabled: true,
  });
  const {
    isPending: configPending,
    // Only a first load that failed: a failed background refetch (refocus,
    // reconnect) keeps the loaded config and the form with what was typed.
    isLoadingError: configError,
    refetch: refetchConfig,
  } = useQuery(orpc.appConfig.queryOptions());
  const { t } = useTranslation(["auth", "common"]);
  const [submitted, setSubmitted] = useState(false);
  const sessionPending =
    authSession.state.status === "pending" || authSession.state.status === "error";

  return (
    <AuthConfigGate
      isPending={sessionPending || configPending}
      isError={configError}
      onRetry={() => refetchConfig()}
      fields={2}
    >
      {submitted ? (
        <AuthCard
          title={t("auth:forgotPassword.successTitle")}
          description={t("auth:forgotPassword.successDescription")}
        >
          <Link
            to="/$lang/login"
            params={{ lang }}
            search={{ redirectTo }}
            className={cn(buttonVariants({ variant: "outline" }), "min-h-[44px] w-full")}
          >
            {t("auth:forgotPassword.backToLogin")}
          </Link>
        </AuthCard>
      ) : (
        <AuthCard
          title={t("auth:forgotPassword.title")}
          description={t("auth:forgotPassword.description")}
        >
          <ForgotPasswordForm lang={lang} onSubmitted={() => setSubmitted(true)} />
          <div className="text-center">
            <Link
              to="/$lang/login"
              params={{ lang }}
              search={{ redirectTo }}
              className={cn(buttonVariants({ variant: "link" }), "min-h-[44px]")}
            >
              {t("auth:forgotPassword.backToLogin")}
            </Link>
          </div>
        </AuthCard>
      )}
    </AuthConfigGate>
  );
}

function ForgotPasswordForm({ lang, onSubmitted }: { lang: string; onSubmitted: () => void }) {
  const { t } = useTranslation(["auth"]);

  const form = useForm({
    defaultValues: { email: "" },
    onSubmit: async ({ value }) => {
      const result = await authClient.requestPasswordReset({
        email: value.email,
        // Better-Auth resolves this against BETTER_AUTH_URL (the web origin)
        // and appends `?token=` (or `?error=INVALID_TOKEN`) after validating
        // the emailed link server-side.
        redirectTo: `/${lang}/reset-password`,
      });
      if (result.error) {
        // Surface rate-limiting so the user knows to wait; for any other error
        // fall through to the success state so we never reveal whether an
        // account exists for that email (no account enumeration).
        if (isRateLimit(result.error)) {
          toast.error(friendly(result.error));
          return;
        }
        console.error("[forgot-password.request]", result.error);
      }
      onSubmitted();
    },
    validators: {
      // Validation messages come from the locale-aware Zod error map installed
      // in `@/i18n/zod`. Don't pass inline strings here.
      onSubmit: z.object({
        email: z.email(),
      }),
    },
  });

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
      className="space-y-4"
    >
      <form.Field name="email">
        {(field) => (
          <TextField
            field={field}
            label={t("auth:fields.email")}
            type="email"
            autoComplete="email"
          />
        )}
      </form.Field>

      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <Button
            type="submit"
            className="min-h-[44px] w-full"
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting ? t("auth:forgotPassword.sending") : t("auth:forgotPassword.submit")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
