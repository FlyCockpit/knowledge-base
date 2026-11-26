import {
  type ForceTwoFactorSettingKey,
  isForcedTwoFactorEnabled,
} from "@knowledge-base/auth/two-factor-policy";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@knowledge-base/ui/components/card";
import { toast } from "@knowledge-base/ui/components/sileo";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { Shield } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SecurityPolicyCard } from "@/components/admin/security-policy-card";
import { InlineRetry } from "@/components/inline-retry";
import { IndexCeilingAdminPanel } from "@/components/kb/index-ceiling-admin-panel";
import { ModelAdminPanel } from "@/components/kb/model-admin-panel";
import { SearchAllLimitAdminPanel } from "@/components/kb/search-all-limit-admin-panel";
import { PageHeader, PageShell } from "@/components/page-shell";
import { pageHead } from "@/lib/page-title";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/admin/settings")({
  staticData: { pendingShape: "form", pendingWidth: "narrow" },
  head: ({ match }) =>
    pageHead(match.context.i18n.t("admin:nav.settings"), match.context.i18n.t("nav:items.admin")),
  component: AdminSettings,
});

function AdminSettings() {
  const { session } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const {
    data: appSettingsData,
    isPending: appSettingsPending,
    isError: appSettingsIsError,
    refetch: refetchAppSettings,
  } = useQuery(orpc.settings.getAll.queryOptions());
  const adminHas2FA = session.user.twoFactorEnabled === true;
  const { t } = useTranslation(["admin", "common"]);

  const updateSetting = useMutation({
    ...orpc.settings.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: orpc.settings.key() });
      },
    }),
    meta: { errorFallbackKey: "admin:settings.updateFailed" },
  });

  // `isForcedTwoFactorEnabled` below resolves an ABSENT row to the shipped
  // default (`FORCE_2FA_DEFAULTS`), so the card shows the policy actually in
  // force — "Required" for admins before anyone has ever written the row,
  // matching what the server gates enforce.
  return (
    <PageShell width="narrow">
      <PageHeader title={t("admin:settings.title")} description={t("admin:settings.description")} />

      {appSettingsPending ? (
        <SettingsSkeleton />
      ) : appSettingsIsError ? (
        <Card>
          <CardContent>
            <InlineRetry
              className="py-12"
              message={t("admin:settings.loadFailed")}
              onRetry={() => refetchAppSettings()}
            />
          </CardContent>
        </Card>
      ) : (
        <SecurityPolicyCard
          policies={[
            {
              key: "force2faInternalUsers",
              enabled: isForcedTwoFactorEnabled(
                "force2faInternalUsers",
                appSettingsData.force2faInternalUsers,
              ),
              title: t("admin:settings.force2faInternalTitle"),
              description: t("admin:settings.force2faInternalDescription"),
            },
            {
              key: "force2faPublicUsers",
              enabled: isForcedTwoFactorEnabled(
                "force2faPublicUsers",
                appSettingsData.force2faPublicUsers,
              ),
              title: t("admin:settings.force2faPublicTitle"),
              description: t("admin:settings.force2faPublicDescription"),
            },
          ]}
          adminHas2FA={adminHas2FA}
          isUpdating={updateSetting.isPending}
          onToggle={(key, newValue) => {
            updateSetting.mutate(
              { key, value: newValue },
              {
                onSuccess: () => {
                  toast.success(successMessageForForceTwoFactor(t, key, newValue));
                },
              },
            );
          }}
        />
      )}
      <ModelAdminPanel />
      <IndexCeilingAdminPanel />
      <SearchAllLimitAdminPanel />
    </PageShell>
  );
}

function successMessageForForceTwoFactor(
  t: TFunction<["admin", "common"]>,
  key: ForceTwoFactorSettingKey,
  value: "true" | "false",
): string {
  if (key === "force2faInternalUsers") {
    return value === "true"
      ? t("admin:settings.force2faInternalEnabled")
      : t("admin:settings.force2faInternalDisabled");
  }
  return value === "true"
    ? t("admin:settings.force2faPublicEnabled")
    : t("admin:settings.force2faPublicDisabled");
}

function SettingsSkeleton() {
  const { t } = useTranslation("admin");
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="size-5" />
          <span className="sr-only">{t("settings.securityTitle")}</span>
          <Skeleton className="h-5 w-32" />
        </CardTitle>
        <CardDescription>
          <Skeleton className="h-4 w-64" />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {["internal", "public"].map((policy) => (
          <div
            key={policy}
            className="flex items-start justify-between gap-4 rounded-lg border p-4"
          >
            <div className="flex-1 space-y-2">
              <Skeleton className="h-5 w-56" />
              <Skeleton className="h-4 w-full max-w-md" />
              <Skeleton className="h-4 w-3/4" />
            </div>
            <Skeleton className="h-[18px] w-20" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
