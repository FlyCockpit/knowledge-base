import { buttonVariants } from "@knowledge-base/ui/components/button";
import { cn } from "@knowledge-base/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { AuthCard } from "@/components/auth/auth-screen";
import { ResendVerification } from "@/components/auth/resend-verification";

/**
 * Terminal state after a successful sign-up: the account exists but is inert
 * until the emailed link is clicked, so say that plainly instead of dropping
 * the user back on a form or bouncing them off an authenticated route.
 * Without mail delivery (`canResend` false) no link went out, and the
 * description alone names what verifies the address instead.
 */
export function SignupCreatedCard({
  lang,
  email,
  canResend,
  redirectTo,
}: {
  lang: string;
  email: string;
  canResend: boolean;
  redirectTo: string | undefined;
}) {
  const { t } = useTranslation(["auth"]);
  return (
    <AuthCard
      title={canResend ? t("auth:verifyEmail.sentTitle") : t("auth:verifyEmail.pendingTitle")}
      description={
        canResend
          ? t("auth:verifyEmail.sentDescription", { email })
          : t("auth:verifyEmail.accountCreatedNoEmail", { email })
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
      {canResend ? <ResendVerification email={email} /> : null}
    </AuthCard>
  );
}
