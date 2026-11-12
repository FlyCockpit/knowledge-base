import type { BackupFreshness } from "@knowledge-base/api/lib/backup-freshness";
import { Button } from "@knowledge-base/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@knowledge-base/ui/components/card";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { AlertTriangle, DatabaseBackup } from "lucide-react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { orpc } from "@/utils/orpc";

/** Headline copy for a verdict. `null` means the worker recorded none — unknown, not healthy. */
function describeStatus(t: TFunction<["admin", "common"]>, status: BackupFreshness | null): string {
  if (status === null) return t("admin:backups.state.unknown");
  switch (status.state) {
    case "fresh":
      return t("admin:backups.state.fresh", { hours: status.ageHours, limit: status.maxAgeHours });
    case "stale":
      return t("admin:backups.state.stale", { hours: status.ageHours, limit: status.maxAgeHours });
    case "empty":
      return t("admin:backups.state.empty");
    case "misconfigured":
      return t("admin:backups.state.misconfigured");
    case "setup-missing":
      return t("admin:backups.state.setupMissing");
    default:
      return t("admin:backups.state.error");
  }
}

/**
 * The extra sentence behind a verdict, when there is one. Reason codes are
 * translated; the misconfiguration reason is the env warning itself, which
 * names the variable to fix and is meant for whoever deploys the app.
 */
function describeReason(
  t: TFunction<["admin", "common"]>,
  status: BackupFreshness | null,
): string | null {
  if (status === null) return null;
  if (status.state === "misconfigured" || status.state === "setup-missing") return status.reason;
  if (status.state !== "fresh" && status.state !== "stale") return null;
  if (status.reason === "future-timestamp") return t("admin:backups.reason.futureTimestamp");
  return null;
}

function StatusTime({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      {label}{" "}
      <time dateTime={new Date(value).toISOString()}>{new Date(value).toLocaleString()}</time>
    </p>
  );
}

/**
 * Backup freshness on the admin overview.
 *
 * A backup cron that silently stops running produces no error anywhere — the
 * worker's periodic verdict (in Redis) is the only signal, so it gets a card
 * that shouts when the newest dump is old, missing, unreadable, or unknown. A
 * null verdict with backups configured means no check has run (or the worker is
 * down); that is an attention state, not a healthy one. A bucket that is set
 * but unusable renders as `misconfigured` with the reason — silence there would
 * mean an operator who mistyped one variable gets no backups and no warning.
 * Renders nothing at all on the provider-only profile, where logical backups
 * are deliberately off.
 */
export function BackupStatusCard({ className }: { className?: string }) {
  const { t } = useTranslation(["admin", "common"]);

  const { data, isPending, isError, isRefetching, refetch } = useQuery(
    orpc.queue.backupStatus.queryOptions(),
  );

  if (isPending) {
    return (
      <Card className={className}>
        <CardHeader className="space-y-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-3 w-52" />
          <Skeleton className="h-11 w-32" />
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card className={className}>
        <CardContent>
          <InlineRetry message={t("admin:backups.loadFailed")} onRetry={() => refetch()} />
        </CardContent>
      </Card>
    );
  }

  // Provider-only profile: logical backups deliberately off.
  if (!data.configured) return null;

  const status = data.status;
  const needsAttention = status === null || status.state !== "fresh";
  const reason = describeReason(t, status);

  return (
    <Card className={cn(needsAttention && "border-destructive/40 bg-destructive/5", className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {needsAttention ? (
            <AlertTriangle aria-hidden className="size-4 text-destructive" />
          ) : (
            <DatabaseBackup aria-hidden className="size-4 text-muted-foreground" />
          )}
          {t("admin:backups.title")}
        </CardTitle>
        <CardDescription className={cn(needsAttention && "text-destructive")}>
          {describeStatus(t, status)}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {status?.state === "error" && (
          <p className="break-words text-xs text-muted-foreground">{status.message}</p>
        )}
        {reason && <p className="break-words text-xs text-muted-foreground">{reason}</p>}
        {(status?.state === "fresh" || status?.state === "stale") && (
          <StatusTime label={t("admin:backups.latestAtLabel")} value={status.latestAt} />
        )}
        {status && (
          <StatusTime label={t("admin:backups.checkedAtLabel")} value={status.checkedAt} />
        )}
        <Button
          variant="outline"
          size="sm"
          className="min-h-[44px]"
          disabled={isRefetching}
          onClick={() => void refetch()}
        >
          {t("common:actions.refresh")}
        </Button>
        {/* Setup runbook for whoever deploys: docs/backup-restore.md.
            Admin-facing copy names the person to ask, not a repo path. */}
        <p className="text-xs text-muted-foreground">{t("admin:backups.docsHint")}</p>
      </CardContent>
    </Card>
  );
}
