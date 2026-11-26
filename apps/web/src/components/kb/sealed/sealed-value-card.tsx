import { Button } from "@knowledge-base/ui/components/button";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { Link } from "@tanstack/react-router";
import { FileText, KeyRound, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { InlineRetry } from "@/components/inline-retry";
import { StatusPill } from "@/components/status-pill";
import {
  formatDate,
  relativeTime,
  type SealedGrant,
  type SealedUsage,
  type SealedValue,
  shortKeyId,
} from "./sealed-logic";

/** `error` also covers a scan that did not finish: never shown as "not used". */
export type UsageState =
  | { status: "pending" }
  | { status: "error"; onRetry?: () => void }
  | { status: "ready" };

export function sealedValueName(value: SealedValue, unnamed: string) {
  return value.label ?? unnamed;
}

function GrantRow({
  grant,
  lang,
  now,
  onRevoke,
}: {
  grant: SealedGrant;
  lang: string;
  now: Date;
  onRevoke: () => void;
}) {
  const { t } = useTranslation("kb");
  const token = grant.tokenName ?? t("settings.sealed.list.removedToken");
  const holder =
    grant.holder.kind === "self"
      ? t("settings.sealed.list.you")
      : grant.holder.kind === "member"
        ? grant.holder.name
        : t("settings.sealed.list.unknownHolder");
  const ended = Date.parse(grant.expiresAt) <= now.getTime();
  return (
    <li
      data-testid="sealed-grant-row"
      data-consumer-id={grant.consumerId}
      data-key-id={grant.recipientKeyId}
      className="flex min-w-0 flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0 space-y-0.5 text-sm">
        <p className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 break-words font-medium">{token}</span>
          <span className="text-muted-foreground">· {holder}</span>
          {!grant.active && (
            <StatusPill tone="muted" data-testid="sealed-grant-inactive">
              {t("settings.sealed.list.inactive")}
            </StatusPill>
          )}
        </p>
        <p className="text-xs text-muted-foreground" data-testid="sealed-grant-key">
          {t("settings.sealed.list.keyId", { id: shortKeyId(grant.recipientKeyId) })}
        </p>
        <p className="text-xs text-muted-foreground">
          {ended
            ? t("settings.sealed.list.accessEnded", { date: formatDate(grant.expiresAt, lang) })
            : t("settings.sealed.list.accessEnds", {
                relative: relativeTime(grant.expiresAt, now, lang),
                date: formatDate(grant.expiresAt, lang),
              })}
        </p>
      </div>
      <Button
        type="button"
        variant="outline"
        data-testid="sealed-grant-revoke"
        className="min-h-[44px] shrink-0"
        aria-label={t("settings.sealed.list.revokeLabel", { token })}
        onClick={onRevoke}
      >
        {t("settings.sealed.list.revoke")}
      </Button>
    </li>
  );
}

function Usage({
  kbId,
  lang,
  usage,
  state,
}: {
  kbId: string;
  lang: string;
  usage: SealedUsage | undefined;
  state: UsageState;
}) {
  const { t } = useTranslation("kb");
  if (state.status === "pending")
    return (
      <div className="space-y-1" aria-busy="true">
        <span className="sr-only">{t("settings.sealed.list.usageLoading")}</span>
        <Skeleton className="h-4 w-48 max-w-full" />
      </div>
    );
  if (state.status === "error" || !usage)
    return state.status === "error" && state.onRetry ? (
      <InlineRetry message={t("settings.sealed.list.usageError")} onRetry={state.onRetry} />
    ) : (
      <p data-testid="sealed-usage-unknown" className="text-xs text-muted-foreground">
        {t("settings.sealed.list.usageError")}
      </p>
    );
  if (usage.paths.length === 0)
    return (
      <p data-testid="sealed-usage-none" className="text-xs text-muted-foreground">
        {t("settings.sealed.list.notUsed")}
      </p>
    );
  return (
    <ul data-testid="sealed-usage" className="min-w-0 space-y-1 text-sm">
      {usage.paths.map((path) => (
        <li key={path} className="min-w-0">
          <Link
            to="/$lang/kbs/$kbId/documents"
            params={{ lang, kbId }}
            search={{ path }}
            className="inline-flex min-h-[44px] min-w-0 items-center gap-1.5 break-all underline underline-offset-4 sm:min-h-0"
          >
            <FileText aria-hidden="true" className="size-3.5 shrink-0" />
            {path}
          </Link>
        </li>
      ))}
      {usage.more && (
        <li className="text-xs text-muted-foreground">{t("settings.sealed.list.usageMore")}</li>
      )}
    </ul>
  );
}

/** One stored value: its name, reference, the documents that use it and the tokens that can read it. */
export function SealedValueCard({
  value,
  kbId,
  lang,
  now,
  usage,
  usageState,
  onGiveAccess,
  onRevokeGrant,
  onDelete,
}: {
  value: SealedValue;
  kbId: string;
  lang: string;
  now: Date;
  usage: SealedUsage | undefined;
  usageState: UsageState;
  onGiveAccess: () => void;
  onRevokeGrant: (grant: SealedGrant) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("kb");
  const name = sealedValueName(value, t("settings.sealed.list.unnamed"));
  const headingId = `sealed-value-${value.recordId}`;
  return (
    <li
      data-testid="sealed-value"
      data-record-id={value.recordId}
      data-reference={value.reference}
      aria-labelledby={headingId}
      className="min-w-0 space-y-4 rounded-lg border p-4"
    >
      <div className="min-w-0 space-y-1">
        <h3 id={headingId} className="flex min-w-0 items-center gap-2 font-semibold">
          <KeyRound aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 break-words">{name}</span>
        </h3>
        <p className="text-xs text-muted-foreground">
          {t("settings.sealed.list.added", { date: formatDate(value.createdAt, lang) })}
        </p>
      </div>
      <div className="min-w-0 space-y-1">
        <p className="text-xs font-medium text-muted-foreground">
          {t("settings.sealed.list.reference")}
        </p>
        <CopyField value={value.reference} copyLabel={t("settings.sealed.list.copyReference")} />
      </div>
      <div className="min-w-0 space-y-1">
        <p className="text-xs font-medium text-muted-foreground">
          {t("settings.sealed.list.usedIn")}
        </p>
        <Usage kbId={kbId} lang={lang} usage={usage} state={usageState} />
      </div>
      <div className="min-w-0 space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          {t("settings.sealed.list.access")}
        </p>
        {value.grants.length === 0 ? (
          <p data-testid="sealed-no-access" className="text-sm text-muted-foreground">
            {t("settings.sealed.list.noAccess")}
          </p>
        ) : (
          <ul className="min-w-0 space-y-2">
            {value.grants.map((grant) => (
              <GrantRow
                key={`${grant.consumerId}:${grant.recipientKeyId}`}
                grant={grant}
                lang={lang}
                now={now}
                onRevoke={() => onRevokeGrant(grant)}
              />
            ))}
          </ul>
        )}
        {value.moreGrants > 0 && (
          <p className="text-xs text-muted-foreground">
            {t("settings.sealed.list.moreGrants", { count: value.moreGrants })}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button
          type="button"
          data-testid="sealed-give-access"
          className="min-h-[44px]"
          onClick={onGiveAccess}
        >
          {t("settings.sealed.list.giveAccess")}
        </Button>
        <Button
          type="button"
          variant="outline"
          data-testid="sealed-delete"
          className="min-h-[44px] text-destructive"
          aria-label={t("settings.sealed.list.deleteLabel", { name })}
          onClick={onDelete}
        >
          <Trash2 aria-hidden="true" className="size-4" />
          {t("settings.sealed.list.delete")}
        </Button>
      </div>
    </li>
  );
}

/** Mirrors one card while the first page loads. */
export function SealedValueCardSkeleton() {
  return (
    <li className="min-w-0 space-y-4 rounded-lg border p-4" aria-hidden="true">
      <div className="space-y-1">
        <Skeleton className="h-5 w-40 max-w-full" />
        <Skeleton className="h-3 w-24" />
      </div>
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-4 w-56 max-w-full" />
      <Skeleton className="h-11 w-32" />
    </li>
  );
}
