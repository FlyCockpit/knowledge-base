import { Button } from "@knowledge-base/ui/components/button";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { AuthCard, AuthScreen } from "@/components/auth/auth-screen";

function AuthScreenSkeleton({ fields = 3 }: { fields?: number }) {
  return (
    <div className="w-full max-w-md space-y-6">
      <div className="space-y-2 text-center">
        <Skeleton className="mx-auto h-8 w-40" />
        <Skeleton className="mx-auto h-4 w-56" />
      </div>
      <div className="space-y-4">
        {Array.from({ length: fields }, (_, index) => (
          <Skeleton key={`auth-skel-${index}`} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}

export function AuthConfigGate({
  isPending,
  isError,
  onRetry,
  skeleton,
  fields,
  children,
}: {
  isPending: boolean;
  isError: boolean;
  onRetry: () => void;
  skeleton?: ReactNode;
  fields?: number;
  children: ReactNode;
}) {
  const { t } = useTranslation(["auth", "common"]);

  if (isPending) {
    return <AuthScreen>{skeleton ?? <AuthScreenSkeleton fields={fields} />}</AuthScreen>;
  }

  if (isError) {
    return (
      <AuthCard
        title={t("auth:login.unableToConnect")}
        description={t("auth:login.unableToConnectDescription")}
      >
        <Button className="min-h-[44px] w-full" onClick={onRetry}>
          {t("common:actions.retry")}
        </Button>
      </AuthCard>
    );
  }

  return children;
}
