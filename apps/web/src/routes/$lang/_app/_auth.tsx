import { Button } from "@knowledge-base/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@knowledge-base/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { TwoFactorNudge } from "@/components/admin/two-factor-nudge";
import { OneTimeCodeField } from "@/components/auth/plain-field";
import { TwoFactorPasswordConfirm } from "@/components/auth/two-factor-password-confirm";
import { InlineRetry } from "@/components/inline-retry";
import { RouteContentSkeleton } from "@/components/route-content-skeleton";
import { TwoFactorSetupDetails } from "@/components/two-factor-setup-details";
import { useTwoFactorEnrollment } from "@/hooks/use-two-factor-enrollment";
import { resolveRouteSession } from "@/lib/route-session";
import { decideProtectedRouteAccess } from "@/lib/route-session-access";
import { setSessionHint } from "@/lib/session-hint";
import { orpc } from "@/utils/orpc";
import { twoFactorEnrollmentState } from "@/utils/two-factor-policy";

export const Route = createFileRoute("/$lang/_app/_auth")({
  beforeLoad: async ({ location, params, context }) => {
    const decision = decideProtectedRouteAccess(await resolveRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-to-login") {
      // Keep the public pages' cookie hint in step with what this gate just
      // learned (lib/session-hint.ts), both ways.
      setSessionHint(context.queryClient, false);
      throw redirect({
        to: "/$lang/login",
        params: { lang: params.lang },
        search: { redirectTo: location.href },
      });
    }
    setSessionHint(context.queryClient, true);
    return { session: decision.session };
  },
  component: AuthLayout,
});

function AuthLayout() {
  const { session } = Route.useRouteContext();
  const {
    data: appSettings,
    isPending,
    isError,
    refetch,
  } = useQuery(orpc.settings.getAll.queryOptions());
  const { t } = useTranslation(["common"]);

  if (isPending) {
    // Inside the app shell already: only the content area waits, in the
    // shape of the page being opened.
    return <RouteContentSkeleton />;
  }

  if (isError) {
    return (
      <div className="container mx-auto max-w-4xl px-4">
        <InlineRetry
          className="py-12"
          message={t("common:appSettingsLoadFailed")}
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  // Forced 2FA is on by default for admins, so an unenrolled covered user gets an
  // enrollment grace window (`@knowledge-base/auth/two-factor-policy`) before this
  // guard blocks them — otherwise the first admin to sign up would be walled
  // off from the app before ever reaching the enrollment screen. Only the
  // post-grace `blocked` state takes over the layout, and the takeover IS the
  // enrollment flow, so nobody is stranded behind it.
  if (twoFactorEnrollmentState(appSettings, session.user).status === "blocked") {
    return <TwoFactorSetupRequired />;
  }

  // Every user the policy covers sees the deadline during the grace.
  return (
    <>
      <TwoFactorNudge audience="account" />
      <Outlet />
    </>
  );
}

function TwoFactorSetupRequired() {
  const { t } = useTranslation(["auth", "common"]);
  // The passwordless hint is only true when SSO is on.
  const { data: config } = useQuery(orpc.appConfig.queryOptions());
  const enrollment = useTwoFactorEnrollment({
    logScope: "_auth",
    messages: {
      startFailed: t("twoFactor.couldNotStartSetup"),
      enabled: t("twoFactor.enabledSuccess"),
      invalidCode: t("errors.invalidTotp"),
      invalidPassword: t("errors.invalidPassword"),
    },
  });
  const { step, password, setPassword, verifyCode, setVerifyCode, isLoading } = enrollment;
  // A way back from every step after the intro (the header's account menu
  // still offers Sign out around this screen).
  const cancel = (
    <Button variant="ghost" className="min-h-[44px] w-full" onClick={enrollment.cancel}>
      {t("common:actions.cancel")}
    </Button>
  );

  return (
    <div className="flex min-h-[80vh] items-center justify-center px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">{t("twoFactor.requiredTitle")}</CardTitle>
          <CardDescription>{t("twoFactor.requiredDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {step === "start" && (
            <>
              <p className="text-sm text-muted-foreground">{t("twoFactor.introText")}</p>
              <Button className="min-h-[44px] w-full" onClick={enrollment.begin}>
                {t("twoFactor.setUp")}
              </Button>
            </>
          )}

          {step === "password" && (
            <>
              <TwoFactorPasswordConfirm
                id="2fa-password"
                prompt={t("twoFactor.passwordPrompt")}
                ssoEnabled={config?.ssoEnabled === true}
                password={password}
                error={enrollment.passwordError}
                inputRef={enrollment.passwordRef}
                onPasswordChange={setPassword}
                onSubmit={enrollment.enroll}
              />
              <Button
                className="min-h-[44px] w-full"
                onClick={enrollment.enroll}
                disabled={isLoading}
              >
                {isLoading ? t("twoFactor.settingUp") : t("twoFactor.continue")}
              </Button>
              {cancel}
            </>
          )}

          {step === "secret" && (
            <>
              <TwoFactorSetupDetails
                backupCodes={enrollment.backupCodes}
                backupCodesLabel={t("twoFactor.backupCodesLabel")}
                manualPrompt={t("twoFactor.addKeyToApp")}
                qrPrompt={t("twoFactor.scanQrPrompt")}
                totpURI={enrollment.totpURI}
              />

              <OneTimeCodeField
                id="verify-code"
                label={t("fields.verificationCode")}
                value={verifyCode}
                error={enrollment.codeError}
                inputRef={enrollment.codeRef}
                onValueChange={setVerifyCode}
                onComplete={enrollment.verify}
              />
              <Button
                className="min-h-[44px] w-full"
                onClick={enrollment.verify}
                disabled={verifyCode.length !== 6 || isLoading}
              >
                {isLoading ? t("twoFactor.verifying") : t("twoFactor.verifyAndEnable")}
              </Button>
              {cancel}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
