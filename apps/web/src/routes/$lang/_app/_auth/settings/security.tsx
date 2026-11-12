import { Button } from "@knowledge-base/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@knowledge-base/ui/components/card";
import { Input } from "@knowledge-base/ui/components/input";
import { Label } from "@knowledge-base/ui/components/label";
import { toast } from "@knowledge-base/ui/components/sileo";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRound, ShieldCheck, ShieldOff } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import z from "zod";

import { TwoFactorSetupDetails } from "@/components/two-factor-setup-details";
import { useTwoFactorEnrollment } from "@/hooks/use-two-factor-enrollment";
import { authClient } from "@/lib/auth-client";
import { pageHead } from "@/lib/page-title";
import { friendly, isRateLimit } from "@/utils/friendly-error";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/settings/security")({
  head: ({ match }) =>
    pageHead(
      match.context.i18n.t("settings:navSecurity"),
      match.context.i18n.t("nav:items.settings"),
    ),
  component: SecuritySettings,
});

function SecuritySettings() {
  const { session } = Route.useRouteContext();
  const has2FA = session.user.twoFactorEnabled === true;
  const { t } = useTranslation("settings");

  return (
    <div className="space-y-6">
      <PasswordSection />
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            {has2FA ? (
              <ShieldCheck className="size-5 text-green-500" />
            ) : (
              <ShieldOff className="size-5 text-muted-foreground" />
            )}
            {t("security.twoFactorTitle")}
          </CardTitle>
          <CardDescription>
            {has2FA ? t("security.enabledDescription") : t("security.disabledDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent>{has2FA ? <Disable2FASection /> : <Enable2FASection />}</CardContent>
      </Card>
    </div>
  );
}

function PasswordSection() {
  const { t } = useTranslation(["settings", "common"]);
  const {
    data: capabilities,
    isPending,
    isError,
    refetch,
  } = useQuery(orpc.auth.passwordCapabilities.queryOptions());

  if (isPending) {
    return <PasswordCardSkeleton />;
  }

  if (isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("settings:security.passwordTitle")}</CardTitle>
          <CardDescription>{t("settings:security.passwordLoadError")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" className="min-h-[44px]" onClick={() => refetch()}>
            {t("common:actions.tryAgain")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!capabilities.canChangePassword) {
    return null;
  }

  return <ChangePasswordCard />;
}

function PasswordCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-full max-w-md" />
      </CardHeader>
      <CardContent className="max-w-lg space-y-4">
        {["current", "new", "confirm"].map((field) => (
          <div key={field} className="space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-8 max-md:min-h-11 w-full" />
          </div>
        ))}
        <Skeleton className="h-8 max-md:min-h-11 w-36" />
      </CardContent>
    </Card>
  );
}

function ChangePasswordCard() {
  const { t } = useTranslation(["settings", "validation"]);

  const form = useForm({
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    },
    validators: {
      onSubmit: z
        .object({
          currentPassword: z.string().min(1),
          newPassword: z.string().min(12).max(128),
          confirmPassword: z.string().min(1),
        })
        .refine((values) => values.newPassword === values.confirmPassword, {
          message: t("validation:passwordsMustMatch"),
          path: ["confirmPassword"],
        }),
    },
    onSubmit: async ({ value }) => {
      try {
        const result = await authClient.changePassword({
          currentPassword: value.currentPassword,
          newPassword: value.newPassword,
          revokeOtherSessions: true,
        });

        if (result.error) {
          const message =
            result.error.code === "INVALID_PASSWORD"
              ? t("settings:security.currentPasswordMismatch")
              : isRateLimit(result.error)
                ? friendly(result.error, t("settings:security.passwordChangeError"))
                : t("settings:security.passwordChangeError");
          toast.error(message);
          return;
        }

        toast.success(t("settings:security.passwordChangedSuccess"));
        form.reset();
      } catch (error) {
        toast.error(
          isRateLimit(error)
            ? friendly(error, t("settings:security.passwordChangeError"))
            : t("settings:security.passwordChangeError"),
        );
      }
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound aria-hidden="true" className="size-5 text-muted-foreground" />
          {t("settings:security.passwordTitle")}
        </CardTitle>
        <CardDescription>{t("settings:security.passwordDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            form.handleSubmit();
          }}
        >
          <form.Field name="currentPassword">
            {(field) => (
              <TextField
                field={field}
                label={t("settings:security.currentPasswordLabel")}
                type="password"
                autoComplete="current-password"
                inputClassName="autofill:shadow-[inset_0_0_0px_1000px_var(--color-background)]"
              />
            )}
          </form.Field>

          <form.Field name="newPassword">
            {(field) => (
              <TextField
                field={field}
                label={t("settings:security.newPasswordLabel")}
                type="password"
                autoComplete="new-password"
                inputClassName="autofill:shadow-[inset_0_0_0px_1000px_var(--color-background)]"
              />
            )}
          </form.Field>

          <form.Field name="confirmPassword">
            {(field) => (
              <TextField
                field={field}
                label={t("settings:security.confirmPasswordLabel")}
                type="password"
                autoComplete="new-password"
                inputClassName="autofill:shadow-[inset_0_0_0px_1000px_var(--color-background)]"
              />
            )}
          </form.Field>

          <p className="text-sm text-muted-foreground">
            {t("settings:security.passwordSessionRevocation")}
          </p>

          <form.Subscribe
            selector={(state) => ({
              canSubmit: state.canSubmit,
              isSubmitting: state.isSubmitting,
            })}
          >
            {({ canSubmit, isSubmitting }) => (
              <Button type="submit" className="min-h-[44px]" disabled={!canSubmit || isSubmitting}>
                {isSubmitting
                  ? t("settings:security.changingPassword")
                  : t("settings:security.changePassword")}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </CardContent>
    </Card>
  );
}

function Enable2FASection() {
  const { t } = useTranslation(["settings", "auth", "common"]);
  const enrollment = useTwoFactorEnrollment({
    logScope: "settings.security",
    messages: {
      startFailed: t("settings:security.couldNotStartSetup"),
      enabled: t("settings:security.enabledSuccess"),
      invalidCode: t("auth:errors.invalidTotp"),
    },
  });
  const { step, password, setPassword, verifyCode, setVerifyCode, isLoading } = enrollment;

  if (step === "start") {
    return (
      <Button className="min-h-[44px]" onClick={enrollment.begin}>
        {t("settings:security.enable2FA")}
      </Button>
    );
  }

  if (step === "password") {
    return (
      <div className="space-y-4 max-w-sm">
        <p className="text-sm text-muted-foreground">
          {t("settings:security.confirmPasswordPrompt")}
        </p>
        <p className="text-sm text-muted-foreground">{t("auth:twoFactor.passwordlessPrompt")}</p>
        <div className="space-y-2">
          <Label htmlFor="confirm-password">{t("auth:fields.password")}</Label>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") enrollment.enroll();
            }}
          />
        </div>
        <div className="flex gap-2">
          <Button className="min-h-[44px]" onClick={enrollment.enroll} disabled={isLoading}>
            {isLoading ? t("auth:twoFactor.settingUp") : t("auth:twoFactor.continue")}
          </Button>
          <Button className="min-h-[44px]" variant="ghost" onClick={enrollment.cancel}>
            {t("common:actions.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  if (step === "secret") {
    return (
      <div className="space-y-4 max-w-sm">
        <TwoFactorSetupDetails
          backupCodes={enrollment.backupCodes}
          backupCodesLabel={t("settings:security.saveBackupCodes")}
          manualPrompt={t("settings:security.addKeyToApp")}
          qrPrompt={t("settings:security.scanQrPrompt")}
          totpURI={enrollment.totpURI}
        />

        <Button className="min-h-[44px]" onClick={enrollment.confirmSaved}>
          {t("settings:security.savedBackupCodes")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-sm">
      <p className="text-sm text-muted-foreground">{t("settings:security.verifyPrompt")}</p>
      <div className="space-y-2">
        <Label htmlFor="setup-verify-code">{t("auth:fields.verificationCode")}</Label>
        <Input
          id="setup-verify-code"
          placeholder="000000"
          value={verifyCode}
          onChange={(e) => setVerifyCode(e.target.value)}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          className="text-center text-lg tracking-widest"
          onKeyDown={(e) => {
            if (e.key === "Enter" && verifyCode.length === 6) enrollment.verify();
          }}
        />
      </div>
      <Button
        className="min-h-[44px]"
        onClick={enrollment.verify}
        disabled={verifyCode.length !== 6 || isLoading}
      >
        {isLoading ? t("auth:twoFactor.verifying") : t("settings:security.verifyAndEnable")}
      </Button>
    </div>
  );
}

function Disable2FASection() {
  const [showConfirm, setShowConfirm] = useState(false);
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const { t } = useTranslation(["settings", "auth", "common"]);

  const handleDisable = async () => {
    setIsLoading(true);
    try {
      const result = await authClient.twoFactor.disable({
        password,
      });
      if (result.error) {
        console.error("[settings.security.twoFactor.disable]", result.error);
        toast.error(t("settings:security.couldNotDisable"));
        return;
      }
      toast.success(t("settings:security.disabledSuccess"));
      window.location.reload();
    } catch (err) {
      console.error("[settings.security.twoFactor.disable]", err);
      toast.error(t("settings:security.couldNotDisable"));
    } finally {
      setIsLoading(false);
    }
  };

  if (!showConfirm) {
    return (
      <Button className="min-h-[44px]" variant="outline" onClick={() => setShowConfirm(true)}>
        {t("settings:security.disable2FA")}
      </Button>
    );
  }

  return (
    <div className="space-y-4 max-w-sm">
      <p className="text-sm text-muted-foreground">{t("settings:security.disablePrompt")}</p>
      <div className="space-y-2">
        <Label htmlFor="disable-password">{t("auth:fields.password")}</Label>
        <Input
          id="disable-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleDisable();
          }}
        />
      </div>
      <div className="flex gap-2">
        <Button
          className="min-h-[44px]"
          variant="destructive"
          onClick={handleDisable}
          disabled={!password || isLoading}
        >
          {isLoading ? t("settings:security.disabling") : t("settings:security.disable")}
        </Button>
        <Button className="min-h-[44px]" variant="ghost" onClick={() => setShowConfirm(false)}>
          {t("common:actions.cancel")}
        </Button>
      </div>
    </div>
  );
}
