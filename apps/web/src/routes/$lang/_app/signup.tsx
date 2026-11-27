import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import { toast } from "@knowledge-base/ui/components/sileo";
import { TextField } from "@knowledge-base/ui/components/text-field";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { AuthConfigGate } from "@/components/auth/auth-config-gate";
import { AuthCard } from "@/components/auth/auth-screen";
import { SignupCreatedCard } from "@/components/auth/signup-created-card";
import { useAuthSession } from "@/hooks/use-auth-session";
import { authClient } from "@/lib/auth-client";
import { markAnonymousOnlyRoute } from "@/lib/document-identity";
import { setServerFieldError } from "@/lib/form-server-error";
import { pageHead } from "@/lib/page-title";
import { newPasswordSchema, PASSWORD_MIN_LENGTH } from "@/lib/password-policy";
import { ensureRouteQuery } from "@/lib/route-query";
import { resolveRouteSession } from "@/lib/route-session";
import { decideAnonymousOnlyRouteAccess } from "@/lib/route-session-access";
import { signupMode } from "@/lib/signup-mode";
import { friendly } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";
import { safeRedirectTo } from "@/utils/safe-redirect";

export const Route = createFileRoute("/$lang/_app/signup")({
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
    const cfg = await ensureRouteQuery(context.queryClient, orpc.appConfig.queryKey(), () =>
      orpc.appConfig.call(),
    );
    // SSO-only servers have no password sign-up at all: their sign-in page
    // explains it. A closed (invite-only) server renders its own state below
    // instead of a silent bounce, so the visitor learns why there is no form.
    if (cfg.forceSso) {
      throw redirect({ to: "/$lang/login", params: { lang: params.lang }, search });
    }
  },
  head: ({ match }) => pageHead(match.context.i18n.t("nav:titles.signUp")),
  component: SignupPage,
});

function SignupPage() {
  markAnonymousOnlyRoute();
  // A peer tab's sign-in replaces this page instead of putting that account in the
  // header above the form (lib/document-identity.ts).
  const { lang } = Route.useParams();
  const { redirectTo } = Route.useSearch();
  const authSession = useAuthSession();
  const {
    data: configData,
    isPending: configPending,
    // Only a first load that failed: a failed background refetch (refocus,
    // reconnect) keeps the loaded config and the form with what was typed.
    isLoadingError: configError,
    refetch: refetchConfig,
  } = useQuery(orpc.appConfig.queryOptions());
  const { t } = useTranslation(["auth", "common"]);
  // Set once the account exists. Better-Auth is configured with
  // `requireEmailVerification: true`, so a successful signup deliberately does
  // NOT return a session — there is nothing to redirect into yet. The address
  // is kept only to name it back to the user and to target a resend.
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  const mode = signupMode(configData ?? {});
  const forceSso = mode === "sso";
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
    body = (
      <SignupCreatedCard
        lang={lang}
        email={pendingEmail}
        canResend={canResend}
        redirectTo={redirectTo}
      />
    );
  } else if (mode === "closed") {
    // Invite-only: say so, and point at the one thing this visitor can do here.
    body = (
      <AuthCard
        title={t("auth:signupMode.closedTitle")}
        description={t("auth:signupMode.closedDescription")}
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
  } else {
    // `open`, or `bootstrap`: only the administrator's first account can sign up, so
    // the card is about setting up the server, and tells everyone else it is
    // invite-only (the flag cannot say whether the admin already exists).
    const bootstrap = mode === "bootstrap";
    body = (
      <AuthCard
        title={bootstrap ? t("auth:signupMode.setupTitle") : t("auth:login.createAccount")}
        description={
          bootstrap ? t("auth:signupMode.setupDescription") : t("auth:login.createDescription")
        }
      >
        <SignUpForm bootstrap={bootstrap} onSignedUp={setPendingEmail} />
        {bootstrap && (
          <p className="text-center text-sm text-muted-foreground">
            {t("auth:signupMode.setupOthers")}
          </p>
        )}
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

function SignUpForm({
  bootstrap,
  onSignedUp,
}: {
  /** Only the administrator's first account can sign up (sign-up mode `bootstrap`). */
  bootstrap: boolean;
  onSignedUp: (email: string) => void;
}) {
  const { t } = useTranslation(["auth"]);
  const emailInput = useRef<HTMLInputElement>(null);

  const form = useForm({
    defaultValues: { name: "", email: "", password: "" },
    onSubmit: async ({ value }) => {
      let result: Awaited<ReturnType<typeof authClient.signUp.email>>;
      try {
        result = await authClient.signUp.email({
          email: value.email,
          password: value.password,
          name: value.name,
        });
      } catch (err) {
        // The request itself failed (server unreachable, offline).
        console.error("[signup.signUp]", err);
        toast.error(friendly(err, t("auth:errors.couldNotCreateAccount")));
        return;
      }
      if (result.error) {
        console.error("[signup.signUp]", result.error);
        // A signup-disabled attempt gets this generic 422 — the same response
        // for every address, registered, admin or not, so reading it reveals
        // nothing (packages/auth/src/signup-response.ts). In bootstrap mode
        // that is the expected answer for anyone but the administrator, so
        // the copy under the email field is written to be true for every
        // address.
        const blocked = result.error.code === "FAILED_TO_CREATE_USER";
        if (result.error.status === 409 || (bootstrap && blocked)) {
          setServerFieldError(
            form,
            "email",
            result.error.status === 409
              ? t("auth:errors.accountAlreadyRegistered")
              : t("auth:signupMode.setupRejected"),
          );
          emailInput.current?.focus();
        } else {
          toast.error(friendly(result.error, t("auth:errors.couldNotCreateAccount")));
        }
        // Dev-only, and guarded here (not in a shared util) so the hint string
        // tree-shakes out of prod bundles.
        if (import.meta.env.DEV && blocked) {
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
        password: newPasswordSchema(),
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
            ref={emailInput}
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
            description={t("auth:fields.passwordRule", { min: PASSWORD_MIN_LENGTH })}
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
