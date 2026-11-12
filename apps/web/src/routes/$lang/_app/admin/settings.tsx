import {
  type ForceTwoFactorSettingKey,
  isForcedTwoFactorEnabled,
} from "@knowledge-base/auth/two-factor-policy";
import { Button } from "@knowledge-base/ui/components/button";
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
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { IndexCeilingAdminPanel } from "@/components/kb/index-ceiling-admin-panel";
import { ModelAdminPanel } from "@/components/kb/model-admin-panel";
import { PageHeader, PageShell } from "@/components/page-shell";
import { pageHead } from "@/lib/page-title";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/admin/settings")({
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
    </PageShell>
  );
}

function SecurityPolicyCard({
  policies,
  adminHas2FA,
  isUpdating,
  onToggle,
}: {
  policies: Array<{
    key: ForceTwoFactorSettingKey;
    enabled: boolean;
    title: string;
    description: string;
  }>;
  adminHas2FA: boolean;
  isUpdating: boolean;
  onToggle: (key: ForceTwoFactorSettingKey, newValue: "true" | "false") => void;
}) {
  const { t } = useTranslation("admin");
  // Changing who must use 2FA applies to every covered account: confirm first (R2-7).
  const [pending, setPending] = useState<{
    key: ForceTwoFactorSettingKey;
    newValue: "true" | "false";
  } | null>(null);
  const confirmKey = pending
    ? `settings.force2faConfirm.${pending.key === "force2faInternalUsers" ? "internal" : "public"}${pending.newValue === "true" ? "Enable" : "Disable"}`
    : null;
  return (
    <Card>
      <ConfirmActionDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={confirmKey ? t(`${confirmKey}Title`) : ""}
        description={confirmKey ? t(`${confirmKey}Description`) : ""}
        confirmLabel={
          pending?.newValue === "true"
            ? t("settings.force2faConfirm.require")
            : t("settings.force2faConfirm.stopRequiring")
        }
        destructive={pending?.newValue === "false"}
        onConfirm={() => {
          if (pending) onToggle(pending.key, pending.newValue);
          setPending(null);
        }}
      />
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="size-5" />
          {t("settings.securityTitle")}
        </CardTitle>
        <CardDescription>{t("settings.securityDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!adminHas2FA && (
          <p className="text-sm text-destructive">{t("settings.force2faAdminWarning")}</p>
        )}
        {policies.map((policy) => (
          <div
            key={policy.key}
            className="flex items-start justify-between gap-4 rounded-lg border p-4"
          >
            <div className="space-y-1">
              <p className="font-medium">{policy.title}</p>
              <p className="text-sm text-muted-foreground">{policy.description}</p>
            </div>
            <Button
              variant={policy.enabled ? "destructive" : "default"}
              size="sm"
              className="min-h-[44px]"
              disabled={(!adminHas2FA && !policy.enabled) || isUpdating}
              aria-label={t(policy.enabled ? "settings.disableNamed" : "settings.enableNamed", {
                name: policy.title,
              })}
              onClick={() =>
                setPending({ key: policy.key, newValue: policy.enabled ? "false" : "true" })
              }
            >
              {isUpdating
                ? t("settings.updating")
                : policy.enabled
                  ? t("settings.disable")
                  : t("settings.enable")}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
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
            <Skeleton className="h-9 w-20" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
