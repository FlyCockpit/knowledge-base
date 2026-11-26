import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import { Input } from "@knowledge-base/ui/components/input";
import { Label } from "@knowledge-base/ui/components/label";
import { toast } from "@knowledge-base/ui/components/sileo";
import { TextField } from "@knowledge-base/ui/components/text-field";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { AuthConfigGate } from "@/components/auth/auth-config-gate";
import { AuthCard } from "@/components/auth/auth-screen";
import { useAuthSession } from "@/hooks/use-auth-session";
import { APP_HOME, appHomeHref } from "@/lib/app-home";
import { authClient } from "@/lib/auth-client";
import { clearServerFieldError, setServerFieldError } from "@/lib/form-server-error";
import { pageHead } from "@/lib/page-title";
import { decideAnonymousOnlyRouteAccess } from "@/lib/route-session-access";
import { type SignupMode, signupMode } from "@/lib/signup-mode";
import {
  isTwoFactorCodeReady,
  sendCodeFailureToast,
  type TwoFactorChallengeMode,
  twoFactorChallengeFailure,
  verifyTwoFactorChallenge,
} from "@/lib/two-factor-challenge";
import { getRouteSession } from "@/server/auth-session";
import { friendly, isCredentialRejection } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";
import { safeRedirectTo } from "@/utils/safe-redirect";

export const Route = createFileRoute("/$lang/_app/login")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { redirectTo: string | undefined; twoFactor?: "true" } => ({
    redirectTo: typeof search.redirectTo === "string" ? search.redirectTo : undefined,
    ...(search.twoFactor === "true" ? { twoFactor: "true" as const } : {}),
  }),
  beforeLoad: async ({ params, search }) => {
    const decision = decideAnonymousOnlyRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-authenticated") {
      throw redirect({ href: safeRedirectTo(search.redirectTo, params.lang) });
    }
  },
  head: ({ match }) => pageHead(match.context.i18n.t("nav:titles.signIn")),
  component: LoginPage,
});

/**
 * The whole 2FA challenge as one state object (rather than five separate
 * `useState` calls) so a step change — entering the challenge, sending an
 * email code, or backing out — is a single update and a single render, with
 * no way for the pieces to drift apart mid-transition.
 *
 * `otpSent` marks the email-OTP path: once the user requests a code by email
 * we verify against verifyOtp instead of verifyTotp. `backupMode` marks the
 * backup-code path (verifyBackupCode), for a user without their authenticator.
 */
const initialTwoFactorState = {
  active: false,
  code: "",
  verifying: false,
  otpSent: false,
  /** Verifying one of the saved backup codes instead of a 6-digit code. */
  backupMode: false,
  sendingOtp: false,
  /** Why the last code was refused, shown under the field until the code changes. */
  codeError: null as string | null,
};

function LoginPage() {
  const { lang } = Route.useParams();
  const { redirectTo, twoFactor: pendingTwoFactor } = Route.useSearch();
  const [twoFactor, setTwoFactor] = useState(() => ({
    ...initialTwoFactorState,
    active: pendingTwoFactor === "true",
  }));
  const authSession = useAuthSession();
  const {
    data: configData,
    isPending: configPending,
    isError: configError,
    refetch: refetchConfig,
  } = useQuery(orpc.appConfig.queryOptions());
  const { t } = useTranslation(["auth", "common"]);

  const ssoEnabled = configData?.ssoEnabled ?? false;
  const forceSso = configData?.forceSso === true;
  const ssoProviderName = configData?.ssoProviderName ?? "SSO";
  const accountMode = signupMode(configData ?? {});
  const emailEnabled = configData?.emailEnabled ?? false;
  const postAuthRedirect = safeRedirectTo(redirectTo, lang);
  const sessionPending =
    authSession.state.status === "pending" || authSession.state.status === "error";

  const handleSsoLogin = async () => {
    const result = await authClient.signIn.social({
      provider: "sso",
      callbackURL: postAuthRedirect,
    });
    if (result.error) {
      console.error("[login.sso]", result.error);
      toast.error(t("auth:login.ssoFailed"));
    }
  };

  const challengeMode: TwoFactorChallengeMode = twoFactor.backupMode
    ? "backup"
    : twoFactor.otpSent
      ? "otp"
      : "totp";
  const codeReady = isTwoFactorCodeReady(challengeMode, twoFactor.code);

  const showChallengeFailure = (error: unknown) => {
    const failure = twoFactorChallengeFailure(challengeMode, error);
    if ("codeErrorKey" in failure) {
      const { codeErrorKey } = failure;
      setTwoFactor((s) => ({ ...s, codeError: t(codeErrorKey) }));
    } else toast.error(failure.toast);
  };

  const handle2FAVerify = async () => {
    setTwoFactor((s) => ({ ...s, verifying: true }));
    try {
      // A backup code goes to its own endpoint; an emailed code to the OTP
      // endpoint; otherwise the code is a TOTP from their authenticator app.
      const result = await verifyTwoFactorChallenge(
        authClient.twoFactor,
        challengeMode,
        twoFactor.code,
      );
      if (result.error) {
        console.error("[login.twoFactor.verify]", result.error);
        // Only a wrong or expired code goes under the field. A rate limit, a
        // lockout or a server failure is not the code's fault: a toast, and
        // the code stays as typed so the same one can be sent again.
        showChallengeFailure(result.error);
      } else {
        toast.success(t("auth:signedInSuccess"));
        window.location.assign(postAuthRedirect);
      }
    } catch (err) {
      console.error("[login.twoFactor.verify]", err);
      showChallengeFailure(err);
    } finally {
      setTwoFactor((s) => ({ ...s, verifying: false }));
    }
  };

  const handleSendEmailOtp = async () => {
    setTwoFactor((s) => ({ ...s, sendingOtp: true }));
    try {
      // Delivery-aware preflight: Better-Auth's send-otp endpoint reports
      // success even when SMTP delivery fails, so verify the transport is
      // actually reachable before telling the user a code is on the way.
      const preflight = await orpc.auth.verifyEmailTransport.call().catch((err) => {
        console.error("[login.twoFactor.verifyEmailTransport]", err);
        return { ok: false };
      });
      if (!preflight.ok) {
        toast.error(t("auth:twoFactor.couldNotSendCode"));
        return;
      }
      const result = await authClient.twoFactor.sendOtp();
      if (result.error) {
        console.error("[login.twoFactor.sendOtp]", result.error);
        toast.error(sendCodeFailureToast(result.error, "answer"));
        return;
      }
      setTwoFactor((s) => ({
        ...s,
        otpSent: true,
        backupMode: false,
        code: "",
        codeError: null,
      }));
      toast.success(t("auth:twoFactor.codeSent"));
    } catch (err) {
      // The request itself failed (server unreachable, offline).
      console.error("[login.twoFactor.sendOtp]", err);
      toast.error(sendCodeFailureToast(err, "thrown"));
    } finally {
      setTwoFactor((s) => ({ ...s, sendingOtp: false }));
    }
  };

  return (
    <AuthConfigGate
      isPending={sessionPending || configPending}
      isError={configError}
      onRetry={() => refetchConfig()}
    >
      {twoFactor.active ? (
        <AuthCard
          title={t("auth:twoFactor.title")}
          description={
            twoFactor.backupMode
              ? t("auth:twoFactor.backupCodeDescription")
              : twoFactor.otpSent
                ? t("auth:twoFactor.emailCodeDescription")
                : t("auth:twoFactor.description")
          }
        >
          <div className="space-y-2">
            {twoFactor.backupMode ? (
              <>
                <Label htmlFor="backup-code">{t("auth:fields.backupCode")}</Label>
                <Input
                  id="backup-code"
                  value={twoFactor.code}
                  onChange={(e) =>
                    setTwoFactor((s) => ({ ...s, code: e.target.value, codeError: null }))
                  }
                  aria-invalid={twoFactor.codeError ? true : undefined}
                  aria-describedby={twoFactor.codeError ? "totp-code-error" : undefined}
                  inputMode="text"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={64}
                  className="text-center text-lg tracking-wider"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing && codeReady) {
                      handle2FAVerify();
                    }
                  }}
                />
              </>
            ) : (
              <>
                <Label htmlFor="totp-code">{t("auth:fields.verificationCode")}</Label>
                <Input
                  id="totp-code"
                  placeholder="000000"
                  value={twoFactor.code}
                  onChange={(e) =>
                    setTwoFactor((s) => ({ ...s, code: e.target.value, codeError: null }))
                  }
                  aria-invalid={twoFactor.codeError ? true : undefined}
                  aria-describedby={twoFactor.codeError ? "totp-code-error" : undefined}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  className="text-center text-lg tracking-widest"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing && codeReady) {
                      handle2FAVerify();
                    }
                  }}
                />
              </>
            )}
            {twoFactor.codeError && (
              <p id="totp-code-error" role="alert" className="text-sm text-destructive">
                {twoFactor.codeError}
              </p>
            )}
          </div>
          <Button
            className="min-h-[44px] w-full"
            onClick={handle2FAVerify}
            disabled={!codeReady || twoFactor.verifying}
          >
            {twoFactor.verifying ? t("auth:twoFactor.verifying") : t("auth:twoFactor.verify")}
          </Button>
          {emailEnabled && !twoFactor.backupMode && (
            <Button
              variant="outline"
              className="min-h-[44px] w-full"
              onClick={handleSendEmailOtp}
              disabled={twoFactor.sendingOtp}
            >
              {twoFactor.sendingOtp
                ? t("auth:twoFactor.sendingCode")
                : twoFactor.otpSent
                  ? t("auth:twoFactor.resendEmailCode")
                  : t("auth:twoFactor.emailMeCode")}
            </Button>
          )}
          <Button
            variant="outline"
            className="min-h-[44px] w-full"
            onClick={() =>
              setTwoFactor((s) => ({
                ...s,
                backupMode: !s.backupMode,
                otpSent: false,
                code: "",
                codeError: null,
              }))
            }
          >
            {twoFactor.backupMode
              ? t("auth:twoFactor.useAuthenticatorCode")
              : t("auth:twoFactor.useBackupCode")}
          </Button>
          <Button
            variant="ghost"
            className="min-h-[44px] w-full"
            onClick={() => setTwoFactor(initialTwoFactorState)}
          >
            {t("auth:twoFactor.cancel")}
          </Button>
        </AuthCard>
      ) : (
        <AuthCard
          title={t("auth:login.signinTitle")}
          description={
            forceSso
              ? t("auth:login.ssoOnlyDescription", { provider: ssoProviderName })
              : t("auth:login.signinDescription")
          }
        >
          {ssoEnabled && (
            <>
              <Button variant="outline" className="min-h-[44px] w-full" onClick={handleSsoLogin}>
                {t("auth:login.ssoContinue", { provider: ssoProviderName })}
              </Button>
              {!forceSso && (
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    {/* The card is flat on phones (AuthCard), so the label
                        masks the rule with the page's colour there. */}
                    <span className="bg-card px-2 text-muted-foreground max-sm:bg-background">
                      {t("auth:login.or")}
                    </span>
                  </div>
                </div>
              )}
            </>
          )}
          {!forceSso && (
            <SignInForm
              lang={lang}
              redirectTo={postAuthRedirect}
              showForgotPassword={emailEnabled}
              onNeeds2FA={() => setTwoFactor({ ...initialTwoFactorState, active: true })}
            />
          )}
          {forceSso && !ssoEnabled && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              {t("auth:login.ssoUnavailable")}
            </div>
          )}
          <SignupEntry mode={accountMode} lang={lang} redirectTo={redirectTo} />
        </AuthCard>
      )}
    </AuthConfigGate>
  );
}

/**
 * The line under the sign-in form that says how to get an account: a link to
 * `/signup` while sign-up is open, a "set up this server" link while only the
 * administrator bootstrap is open, and the invite-only note when it is
 * closed, so a visitor without an account is never left guessing.
 * docs/ui.md § Sign-up modes.
 */
function SignupEntry({
  mode,
  lang,
  redirectTo,
}: {
  mode: SignupMode;
  lang: string;
  redirectTo: string | undefined;
}) {
  const { t } = useTranslation(["auth"]);
  if (mode === "sso") return null;
  if (mode === "closed") {
    return (
      <p className="text-center text-sm text-muted-foreground">{t("auth:signupMode.inviteOnly")}</p>
    );
  }
  return (
    // `max-sm:-mt-2`: on phones the link's 44px box may use half of the
    // gap above it (its text sits 12px inside the box), which keeps it
    // above a first visit's cookie banner at 320×568.
    <div className="text-center max-sm:-mt-2">
      <Link
        to="/$lang/signup"
        params={{ lang }}
        search={{ redirectTo }}
        className={cn(buttonVariants({ variant: "link" }), "min-h-[44px] whitespace-normal")}
      >
        {mode === "bootstrap" ? t("auth:signupMode.setupHint") : t("auth:login.signupHint")}
      </Link>
    </div>
  );
}

function SignInForm({
  lang,
  redirectTo,
  showForgotPassword,
  onNeeds2FA,
}: {
  lang: string;
  redirectTo: string;
  showForgotPassword: boolean;
  onNeeds2FA: () => void;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation(["auth"]);
  const passwordInput = useRef<HTMLInputElement>(null);
  // "Not verified yet" is a notice under the email field, not a field error:
  // a field error would keep the form unsubmittable until the email is edited,
  // but the fix happens elsewhere (the link in the inbox) and the same
  // credentials must work right after it.
  const [unverified, setUnverified] = useState(false);

  const form = useForm({
    defaultValues: { email: "", password: "" },
    onSubmit: async ({ value }) => {
      setUnverified(false);
      let result: Awaited<ReturnType<typeof authClient.signIn.email>>;
      try {
        result = await authClient.signIn.email({
          email: value.email,
          password: value.password,
        });
      } catch (err) {
        // The request itself failed (server unreachable, offline): say so,
        // and the same credentials can be sent again.
        console.error("[login.signIn]", err);
        toast.error(friendly(err));
        return;
      }
      if (result.error) {
        // `requireEmailVerification` rejects correct credentials on an
        // unverified account. Better-Auth distinguishes this itself, so say so
        // — the generic "email or password doesn't match" sends the user to
        // password reset for a problem a link in their inbox already solves.
        // This leaks nothing: the caller supplied the matching password.
        //
        // `emailVerification.sendOnSignIn` is on, so Better-Auth has already
        // mailed a fresh link by the time we get here — but the original may
        // have expired days ago, so the message under the email field comes
        // with a link to the resend page rather than leaving a dead end if
        // that mail doesn't arrive.
        if (result.error.code === "EMAIL_NOT_VERIFIED") {
          setUnverified(true);
          return;
        }
        if (!isCredentialRejection(result.error)) {
          // Not about either field (rate limit, server or network trouble):
          // a short-lived notice, and the same credentials can be sent again.
          toast.error(friendly(result.error));
          return;
        }
        // Under the password field (it is the one the user retypes), never
        // saying which of the two was wrong.
        setServerFieldError(form, "password", t("auth:errors.invalidCredentials"));
        passwordInput.current?.focus();
        passwordInput.current?.select();
        return;
      }
      if ((result.data as Record<string, unknown>)?.twoFactorRedirect) {
        onNeeds2FA();
        return;
      }
      toast.success(t("auth:signedInSuccess"));
      if (redirectTo === appHomeHref(lang)) {
        navigate({ to: APP_HOME, params: { lang } });
      } else {
        window.location.assign(redirectTo);
      }
    },
    validators: {
      // Validation messages come from the locale-aware Zod error map installed
      // in `@/i18n/zod`. Don't pass inline strings here — that would override
      // the global map and leak hardcoded English copy into es-MX UIs.
      onSubmit: z.object({
        email: z.email(),
        password: z.string().min(8),
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
      {/* A credential rejection sits under the password but is about both
          fields: correcting only the email must let the form submit again. */}
      <form.Field
        name="email"
        listeners={{ onChange: () => clearServerFieldError(form, "password") }}
      >
        {(field) => (
          <div className="space-y-1">
            <TextField
              field={field}
              label={t("auth:fields.email")}
              type="email"
              autoComplete="email"
            />
            {unverified && (
              <p role="alert" className="text-sm text-destructive">
                {t("auth:verifyEmail.notVerified")}
              </p>
            )}
            {unverified && (
              <Link
                to="/$lang/verify-email"
                params={{ lang }}
                // No `ok`: this is a self-navigation, not a verification hop,
                // so the page must show its neutral resend state.
                search={{ error: undefined, ok: undefined }}
                className={cn(buttonVariants({ variant: "link" }), "min-h-[44px] px-0")}
              >
                {t("auth:verifyEmail.resend")}
              </Link>
            )}
          </div>
        )}
      </form.Field>

      {/* Phones: "Forgot password?" sits in the Password label's row, so
          turning email on does not push the sign-up link below a first
          visit's cookie banner at 320×568. Its 44px box fills the space from
          the email input's bottom edge to the password input's top edge (the
          6px `pt` makes that space 44px) and never overlaps either input; the
          label is aligned to the box's bottom. From `sm` up it keeps its own
          row under the field. DOM order is the same at every width: password,
          then the link, then submit. */}
      <div className={cn("relative space-y-4", showForgotPassword && "max-sm:pt-1.5")}>
        <form.Field name="password">
          {(field) => (
            <TextField
              field={field}
              ref={passwordInput}
              label={t("auth:fields.password")}
              type="password"
              autoComplete="current-password"
            />
          )}
        </form.Field>

        {showForgotPassword && (
          <div className="text-right max-sm:absolute max-sm:-top-4 max-sm:right-0 max-sm:mt-0">
            <Link
              to="/$lang/forgot-password"
              params={{ lang }}
              search={{ redirectTo }}
              className={cn(
                buttonVariants({ variant: "link" }),
                "min-h-[44px] px-0 text-sm text-muted-foreground max-sm:h-11 max-sm:items-end max-sm:pb-[5px]",
              )}
            >
              {t("auth:login.forgotPassword")}
            </Link>
          </div>
        )}
      </div>

      <form.Subscribe
        selector={(state) => ({ canSubmit: state.canSubmit, isSubmitting: state.isSubmitting })}
      >
        {({ canSubmit, isSubmitting }) => (
          <Button
            type="submit"
            className="min-h-[44px] w-full"
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting ? t("auth:login.signingIn") : t("auth:login.signIn")}
          </Button>
        )}
      </form.Subscribe>
    </form>
  );
}
