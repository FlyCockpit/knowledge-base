import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import { toast } from "@knowledge-base/ui/components/sileo";
import { TextField } from "@knowledge-base/ui/components/text-field";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { AuthConfigGate } from "@/components/auth/auth-config-gate";
import { AuthCard } from "@/components/auth/auth-screen";
import { authClient } from "@/lib/auth-client";
import { pageHead } from "@/lib/page-title";
import { newPasswordSchema, PASSWORD_MIN_LENGTH } from "@/lib/password-policy";
import { ensureRouteQuery } from "@/lib/route-query";
import { decideAnonymousOnlyRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";
import { friendly, isRateLimit } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/reset-password")({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === "string" ? search.token : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
    // An admin invitation's one-time "set your password" link: the
    // same reset token, with set-password wording. The router's JSON search
    // parser reads `invite=1` as the number 1 (and writes it back unquoted).
    invite: search.invite === 1 || search.invite === "1" ? (1 as const) : undefined,
    // The SETUP_KEY first-admin link (packages/api/src/lib/setup-admin.ts):
    // its token is spent by `setup.claimFirstAdmin`, not by Better-Auth.
    setup: search.setup === 1 || search.setup === "1" ? (1 as const) : undefined,
  }),
  beforeLoad: async ({ context, params }) => {
    const decision = decideAnonymousOnlyRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-authenticated") {
      throw redirect({ to: "/$lang/settings/security", params: { lang: params.lang } });
    }
    // Same SSO deflection as signup: an SSO-only org has no password flow.
    const cfg = await ensureRouteQuery(context.queryClient, orpc.appConfig.queryKey(), () =>
      orpc.appConfig.call(),
    );
    if (cfg.forceSso) {
      throw redirect({
        to: "/$lang/login",
        params: { lang: params.lang },
        search: { redirectTo: undefined },
      });
    }
  },
  // An invitation sets a first password; its tab says so like its heading.
  head: ({ match }) =>
    pageHead(
      match.context.i18n.t(
        match.search.invite === 1 || match.search.setup === 1
          ? "nav:titles.setPassword"
          : "nav:titles.resetPassword",
      ),
    ),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { lang } = Route.useParams();
  const { token, error, invite, setup } = Route.useSearch();
  const isSetup = setup === 1;
  const isInvite = invite === 1 && !isSetup;
  const {
    isPending: configPending,
    isError: configError,
    refetch: refetchConfig,
  } = useQuery(orpc.appConfig.queryOptions());
  const { t } = useTranslation(["auth", "common"]);
  // Better-Auth redirects here with `?error=INVALID_TOKEN` for a bad token; a
  // token that validates on request but is rejected at reset time flips this.
  const [tokenRejected, setTokenRejected] = useState(false);
  const [done, setDone] = useState(false);

  const isInvalid = !done && (!token || !!error || tokenRejected);

  return (
    <AuthConfigGate
      isPending={configPending}
      isError={configError}
      onRetry={() => refetchConfig()}
      fields={2}
    >
      {done && isSetup ? (
        <AuthCard
          title={t("auth:resetPassword.setupDoneTitle")}
          description={t("auth:resetPassword.setupDoneDescription")}
        >
          <Link
            to="/$lang/login"
            params={{ lang }}
            search={{ redirectTo: undefined }}
            className={cn(buttonVariants(), "min-h-[44px] w-full")}
          >
            {t("auth:resetPassword.inviteSignIn")}
          </Link>
        </AuthCard>
      ) : isInvalid && isSetup ? (
        // A setup link is re-issued from the deploy, not by email.
        <AuthCard
          title={t("auth:resetPassword.setupInvalidTitle")}
          description={t("auth:resetPassword.setupInvalidDescription")}
        >
          <Link
            to="/$lang/login"
            params={{ lang }}
            search={{ redirectTo: undefined }}
            className={cn(buttonVariants({ variant: "outline" }), "min-h-[44px] w-full")}
          >
            {t("auth:forgotPassword.backToLogin")}
          </Link>
        </AuthCard>
      ) : done && isInvite ? (
        <AuthCard
          title={t("auth:resetPassword.inviteDoneTitle")}
          description={t("auth:resetPassword.inviteDoneDescription")}
        >
          <Link
            to="/$lang/login"
            params={{ lang }}
            search={{ redirectTo: undefined }}
            className={cn(buttonVariants(), "min-h-[44px] w-full")}
          >
            {t("auth:resetPassword.inviteSignIn")}
          </Link>
        </AuthCard>
      ) : done ? (
        <AuthCard
          title={t("auth:resetPassword.doneTitle")}
          description={t("auth:resetPassword.doneDescription")}
        >
          <p className="text-sm text-muted-foreground">{t("auth:resetPassword.doneReview")}</p>
          <Link
            to="/$lang/login"
            params={{ lang }}
            search={{ redirectTo: `/${lang}/settings/mcp?review=password-reset` }}
            className={cn(buttonVariants(), "min-h-[44px] w-full")}
          >
            {t("auth:resetPassword.doneSignIn")}
          </Link>
        </AuthCard>
      ) : isInvalid ? (
        <AuthCard
          title={t("auth:resetPassword.invalidTitle")}
          description={
            isInvite
              ? t("auth:resetPassword.inviteInvalidDescription")
              : t("auth:resetPassword.invalidDescription")
          }
        >
          <Link
            to="/$lang/forgot-password"
            params={{ lang }}
            search={{ redirectTo: undefined }}
            className={cn(buttonVariants(), "min-h-[44px] w-full")}
          >
            {t("auth:resetPassword.requestNewLink")}
          </Link>
        </AuthCard>
      ) : (
        <AuthCard
          title={
            isSetup
              ? t("auth:resetPassword.setupTitle")
              : isInvite
                ? t("auth:resetPassword.inviteTitle")
                : t("auth:resetPassword.title")
          }
          description={
            isSetup
              ? t("auth:resetPassword.setupDescription")
              : isInvite
                ? t("auth:resetPassword.inviteDescription")
                : t("auth:resetPassword.description")
          }
        >
          <ResetPasswordForm
            isInvite={isInvite}
            isSetup={isSetup}
            token={token ?? ""}
            onTokenRejected={() => setTokenRejected(true)}
            onDone={() => setDone(true)}
          />
        </AuthCard>
      )}
    </AuthConfigGate>
  );
}

/** `setup.claimFirstAdmin` refused the link itself (expired, replaced, used). */
function isSetupLinkInvalid(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "SETUP_LINK_INVALID"
  );
}

function ResetPasswordForm({
  isInvite,
  isSetup,
  token,
  onTokenRejected,
  onDone,
}: {
  isInvite: boolean;
  isSetup: boolean;
  token: string;
  onTokenRejected: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation(["auth", "validation"]);
  // Errors are toasted below (a dead link also swaps in the invalid-link card),
  // so the global mutation toast would only repeat them.
  const { mutateAsync: claimSetupLink } = useMutation(
    orpc.setup.claimFirstAdmin.mutationOptions({ meta: { skipGlobalErrorToast: true } }),
  );

  /** The SETUP_KEY link: spent by our own procedure. True when the admin exists. */
  async function claimFirstAdmin(newPassword: string): Promise<boolean> {
    try {
      await claimSetupLink({ token, newPassword });
      return true;
    } catch (err) {
      console.error("[reset-password.setup]", err);
      if (isSetupLinkInvalid(err)) {
        toast.error(t("auth:resetPassword.failed"));
        onTokenRejected();
        return false;
      }
      toast.error(friendly(err));
      return false;
    }
  }

  const form = useForm({
    defaultValues: { newPassword: "", confirmPassword: "" },
    onSubmit: async ({ value }) => {
      if (isSetup) {
        if (!(await claimFirstAdmin(value.newPassword))) return;
        toast.success(t("auth:resetPassword.setupSuccess"));
        onDone();
        return;
      }
      const result = await authClient.resetPassword({
        newPassword: value.newPassword,
        token,
      });
      if (result.error) {
        if (isRateLimit(result.error)) {
          toast.error(friendly(result.error));
          return;
        }
        // A rejected token (expired / already used) is the common failure here
        // — surface the invalid state with a path back to forgot-password.
        console.error("[reset-password.reset]", result.error);
        toast.error(t("auth:resetPassword.failed"));
        onTokenRejected();
        return;
      }
      // The reset signed out every browser session. Tokens and connected
      // apps keep working, so the success screen sends the user to review them.
      toast.success(
        isInvite ? t("auth:resetPassword.inviteSuccess") : t("auth:resetPassword.success"),
      );
      onDone();
    },
    validators: {
      // Standard checks (min length, required) localize through the global Zod
      // error map; only the cross-field match needs an explicit message, which
      // lives in the `validation` namespace.
      onSubmit: z
        .object({
          // The same length rule Better-Auth enforces (lib/password-policy.ts).
          newPassword: newPasswordSchema(),
          // Only has to match; the rule is reported once, on the new password.
          confirmPassword: z.string().min(1),
        })
        .refine((v) => v.newPassword === v.confirmPassword, {
          message: t("validation:passwordsMustMatch"),
          path: ["confirmPassword"],
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
      <form.Field name="newPassword">
        {(field) => (
          <TextField
            field={field}
            label={t("auth:resetPassword.newPasswordLabel")}
            description={t("auth:fields.passwordRule", { min: PASSWORD_MIN_LENGTH })}
            type="password"
            autoComplete="new-password"
          />
        )}
      </form.Field>

      <form.Field name="confirmPassword">
        {(field) => (
          <TextField
            field={field}
            label={t("auth:resetPassword.confirmPasswordLabel")}
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
            {isSubmitting
              ? t("auth:resetPassword.resetting")
              : isSetup
                ? t("auth:resetPassword.setupSubmit")
                : isInvite
                  ? t("auth:resetPassword.inviteSubmit")
                  : t("auth:resetPassword.submit")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
