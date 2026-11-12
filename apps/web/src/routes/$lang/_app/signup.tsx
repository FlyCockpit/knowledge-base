import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import { toast } from "@knowledge-base/ui/components/sileo";
import { TextField } from "@knowledge-base/ui/components/text-field";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { AuthConfigGate } from "@/components/auth/auth-config-gate";
import { AuthCard } from "@/components/auth/auth-screen";
import { ResendVerification } from "@/components/auth/resend-verification";
import { useAuthSession } from "@/hooks/use-auth-session";
import { authClient } from "@/lib/auth-client";
import { pageHead } from "@/lib/page-title";
import { decideAnonymousOnlyRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";
import { safeRedirectTo } from "@/utils/safe-redirect";

export const Route = createFileRoute("/$lang/_app/signup")({
  validateSearch: (search: Record<string, unknown>) => ({
    redirectTo: typeof search.redirectTo === "string" ? search.redirectTo : undefined,
  }),
  beforeLoad: async ({ context, params, search }) => {
    const decision = decideAnonymousOnlyRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-authenticated") {
      throw redirect({ href: safeRedirectTo(search.redirectTo, params.lang) });
    }
    const cfg = await context.queryClient.ensureQueryData(orpc.appConfig.queryOptions());
    if (cfg.forceSso || (!cfg.signupEnabled && !cfg.adminBootstrapSignupEnabled)) {
      throw redirect({ to: "/$lang/login", params: { lang: params.lang }, search });
    }
  },
  head: ({ match }) => pageHead(match.context.i18n.t("nav:titles.signUp")),
  component: SignupPage,
});

function SignupPage() {
  const { lang } = Route.useParams();
  const { redirectTo } = Route.useSearch();
  const authSession = useAuthSession();
  const {
    data: configData,
    isPending: configPending,
    isError: configError,
    refetch: refetchConfig,
  } = useQuery(orpc.appConfig.queryOptions());
  const { t } = useTranslation(["auth", "common"]);
  // Set once the account exists. Better-Auth is configured with
  // `requireEmailVerification: true`, so a successful signup deliberately does
  // NOT return a session — there is nothing to redirect into yet. The address
  // is kept only to name it back to the user and to target a resend.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  const forceSso = configData?.forceSso === true;
  // Same gate as /$lang/verify-email: resending needs a working mail transport
  // and a password flow to come back to. Without it the card below must not
  // claim a link was sent, or offer a button that can only ever error.
  const canResend = configData?.emailEnabled === true && !forceSso;
  const sessionPending =
    authSession.state.status === "pending" || authSession.state.status === "error";

  let body: ReactNode;
  if (forceSso) {
    body = (
      <AuthCard
        title={t("auth:login.ssoRequiredTitle")}
        description={t("auth:login.ssoRequiredDescription")}
      >
        <Link
          to="/$lang/login"
          params={{ lang }}
          search={{ redirectTo }}
          className={cn(buttonVariants(), "min-h-[44px] w-full")}
        >
          {t("auth:login.signIn")}
        </Link>
      </AuthCard>
    );
  } else if (pendingEmail) {
    // Terminal state after a successful signup: the account exists but is inert
    // until the emailed link is clicked, so say that plainly instead of dropping
    // the user back on a form or bouncing them off an authenticated route.
    body = (
      <AuthCard
        title={canResend ? t("auth:verifyEmail.sentTitle") : t("auth:verifyEmail.pendingTitle")}
        description={
          canResend
            ? t("auth:verifyEmail.sentDescription", { email: pendingEmail })
            : t("auth:verifyEmail.accountCreatedNoEmail", { email: pendingEmail })
        }
      >
        <Link
          to="/$lang/login"
          params={{ lang }}
          search={{ redirectTo }}
          className={cn(buttonVariants(), "min-h-[44px] w-full")}
        >
          {t("auth:verifyEmail.signIn")}
        </Link>
        {canResend ? (
          <ResendVerification email={pendingEmail} />
        ) : (
          <p className="text-center text-sm text-muted-foreground">
            {t("auth:verifyEmail.emailUnavailable")}
          </p>
        )}
      </AuthCard>
    );
  } else {
    body = (
      <AuthCard
        title={t("auth:login.createAccount")}
        description={t("auth:login.createDescription")}
      >
        <SignUpForm onSignedUp={setPendingEmail} />
        <div className="text-center">
          <Link
            to="/$lang/login"
            params={{ lang }}
            search={{ redirectTo }}
            className={cn(buttonVariants({ variant: "link" }), "min-h-[44px]")}
          >
            {t("auth:login.signinHint")}
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthConfigGate
      isPending={sessionPending || configPending}
      isError={configError}
      onRetry={() => refetchConfig()}
    >
      {body}
    </AuthConfigGate>
  );
}

function SignUpForm({ onSignedUp }: { onSignedUp: (email: string) => void }) {
  const { t } = useTranslation(["auth"]);

  const form = useForm({
    defaultValues: { name: "", email: "", password: "" },
    onSubmit: async ({ value }) => {
      const result = await authClient.signUp.email({
        email: value.email,
        password: value.password,
        name: value.name,
      });
      if (result.error) {
        console.error("[signup.signUp]", result.error);
        toast.error(
          result.error?.status === 409
            ? t("auth:errors.accountAlreadyRegistered")
            : friendly(result.error, t("auth:errors.couldNotCreateAccount")),
        );
        // Better-Auth's database hook rejects signup-disabled attempts with a
        // plain Error, which the sign-up route converts to this generic 422 —
        // the same response for every address, member or not, so reading it
        // reveals nothing about whether an admin already exists (see
        // apps/server/src/signup-gate.ts). Dev-only, and guarded here (not in
        // a shared util) so the hint string tree-shakes out of prod bundles.
        if (import.meta.env.DEV && result.error?.code === "FAILED_TO_CREATE_USER") {
          toast.error(t("auth:errors.signupDisabledDevHint"));
        }
        return;
      }
      toast.success(t("auth:accountCreatedSuccess"));
      // No navigation: `requireEmailVerification` means signUp.email returns no
      // session, so anything behind the `_auth` guard would bounce straight back
      // to login. Hand the address up and let the page render the
      // check-your-email state instead.
      onSignedUp(value.email);
    },
    validators: {
      // Validation messages come from the locale-aware Zod error map installed
      // in `@/i18n/zod`. Don't pass inline strings here — that would override
      // the global map and leak hardcoded English copy into es-MX UIs.
      onSubmit: z.object({
        name: z.string().min(2),
        email: z.email(),
        password: z.string().min(12),
      }),
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
      className="space-y-4"
    >
      <form.Field name="name">
        {(field) => (
          <TextField
            field={field}
            label={t("auth:fields.name")}
            inputMode="text"
            autoComplete="name"
          />
        )}
      </form.Field>

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

      <form.Field name="password">
        {(field) => (
          <TextField
            field={field}
            label={t("auth:fields.password")}
            type="password"
            autoComplete="new-password"
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
            {isSubmitting ? t("auth:login.creatingAccount") : t("auth:login.signUp")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
