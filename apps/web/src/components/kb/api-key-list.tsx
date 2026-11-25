import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { Button } from "@knowledge-base/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@knowledge-base/ui/components/dialog";
import { toast } from "@knowledge-base/ui/components/sileo";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { KeyRound, Plus } from "lucide-react";
import type * as React from "react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { ApiKeyNextSteps } from "@/components/kb/api-key-next-steps";
import { AuthoringModeSummary } from "@/components/kb/authoring-mode-picker";
import { CheckRow } from "@/components/kb/check-row";
import { expired, TokenStatePill } from "@/components/kb/credential-list";
import { presetFor } from "@/components/kb/tool-group-picker";
import { LoadMore } from "@/components/load-more";
import { orpc } from "@/utils/orpc";

type Client = AppRouterClient;
export type ApiKeyRow = Awaited<ReturnType<Client["apiKeys"]["listMine"]>>["items"][number];
export type ChildTokenRow = Awaited<
  ReturnType<Client["apiKeys"]["listChildrenMine"]>
>["items"][number];
type ApiKeyRevokeInput = Parameters<Client["apiKeys"]["revokeMine"]>[0];
type ApiKeyRevokeChildrenInput = Parameters<Client["apiKeys"]["revokeChildrenMine"]>[0];

function useDateFormat(lang: string) {
  return (value: Date | string) =>
    new Date(value).toLocaleDateString(lang, { year: "numeric", month: "short", day: "numeric" });
}

/** The key's ceiling and what it may do, in words (shared by the list and details). */
function ApiKeySummary({ apiKey, lang }: { apiKey: ApiKeyRow; lang: string }) {
  const { t } = useTranslation("settings");
  const date = useDateFormat(lang);
  const capabilities = [
    apiKey.allowCreate ? t("apiKeys.can.create") : null,
    apiKey.allowDelete ? t("apiKeys.can.delete") : null,
    apiKey.allowMintChildren ? t("apiKeys.can.mint") : null,
  ].filter((value): value is string => value !== null);
  return (
    <>
      <p className="text-xs">
        {t(`apiKeys.reachSummary.${apiKey.reach}`, { count: apiKey.kbCount })}
      </p>
      <p className="text-xs">
        {t("apiKeys.bitsSummary", {
          bits: apiKey.bits.map((bit) => t(`credentials.picker.bits.${bit}.label`)).join(", "),
        })}
      </p>
      <p className="text-xs">
        {capabilities.length === 0
          ? t("apiKeys.can.none")
          : t("apiKeys.can.list", { items: capabilities.join(", ") })}
      </p>
      {apiKey.allowMintChildren && (
        <>
          <p className="text-xs">
            {t("apiKeys.childGroupsSummary", { groups: groupsLabel(apiKey.childToolGroups, t) })}
          </p>
          <p className="text-xs">
            {apiKey.childAuthoringMode === null
              ? t("apiKeys.childReadOnly")
              : t("apiKeys.childWriteMode", {
                  mode: t(`credentials.writeMode.modes.${apiKey.childAuthoringMode}.label`),
                })}
          </p>
          {apiKey.childAllowCreate && (
            <p className="text-xs">{t("apiKeys.childAllowCreateSummary")}</p>
          )}
          <p className="text-xs">
            {t(
              apiKey.childrenEndWithKey
                ? "apiKeys.childrenEndWithKeySummary.on"
                : "apiKeys.childrenEndWithKeySummary.off",
            )}
          </p>
          <p className="text-xs">{t("apiKeys.liveChildren", { count: apiKey.liveChildren })}</p>
        </>
      )}
      <p className="text-xs text-muted-foreground">
        {apiKey.revokedAt
          ? t("credentials.revoked")
          : apiKey.expiresAt === null
            ? t("credentials.neverExpires")
            : t(expired(apiKey.expiresAt) ? "apiKeys.expired" : "credentials.expires", {
                date: date(apiKey.expiresAt),
              })}{" "}
        ·{" "}
        {apiKey.lastUsedAt
          ? t("apiKeys.lastUsed", { date: date(apiKey.lastUsedAt) })
          : t("apiKeys.neverUsed")}
      </p>
    </>
  );
}

function groupsLabel(groups: readonly string[], t: TFunction<"settings">) {
  const preset = presetFor(groups);
  return preset === "custom"
    ? groups.map((group) => t(`credentials.picker.groups.${group}.label`)).join(", ")
    : t(`credentials.picker.presets.${preset}.label`);
}

type ApiKeyListProps = {
  lang: string;
  keys: readonly ApiKeyRow[];
  onCreate: () => void;
  onDetails: (key: ApiKeyRow) => void;
  onRevoke: (key: ApiKeyRow) => void;
  footer?: React.ReactNode;
};

/** The signed-in user's own REST API keys. Rows never carry a secret. */
export function ApiKeyList({ lang, keys, onCreate, onDetails, onRevoke, footer }: ApiKeyListProps) {
  const { t } = useTranslation("settings");
  return (
    <section className="space-y-3" aria-labelledby="api-keys-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="api-keys-title" className="text-lg font-semibold">
          {t("apiKeys.listTitle")}
        </h2>
        <Button className="min-h-[44px]" onClick={onCreate}>
          <Plus className="size-4" />
          {t("apiKeys.create")}
        </Button>
      </div>
      {keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("apiKeys.noKeys")}</p>
      ) : (
        <ul className="grid min-w-0 gap-3">
          {keys.map((apiKey) => (
            <li
              key={apiKey.id}
              className="flex min-w-0 flex-wrap items-start gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <KeyRound className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="truncate font-medium">{apiKey.name}</span>
                  <TokenStatePill revokedAt={apiKey.revokedAt} expiresAt={apiKey.expiresAt} />
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  kbk_{apiKey.lookupPrefix}
                </p>
                <ApiKeySummary apiKey={apiKey} lang={lang} />
              </div>
              <Button
                variant="outline"
                className="min-h-[44px]"
                aria-label={t("apiKeys.detailsFor", { name: apiKey.name })}
                onClick={() => onDetails(apiKey)}
              >
                {t("apiKeys.details")}
              </Button>
              {!apiKey.revokedAt && (
                <Button
                  variant="outline"
                  className="min-h-[44px]"
                  aria-label={t("credentials.revokeFor", { name: apiKey.name })}
                  onClick={() => onRevoke(apiKey)}
                >
                  {t("credentials.revoke")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {footer}
    </section>
  );
}

/** View details → Dialog: the key's knowledge bases and the tokens it minted. */
export function ApiKeyDetailsDialog({
  apiKey,
  lang,
  serverUrl,
  onOpenChange,
}: {
  apiKey: ApiKeyRow | null;
  lang: string;
  /** This server's URL, for the minting example. */
  serverUrl: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <Dialog open={apiKey !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto overflow-x-hidden sm:max-w-2xl">
        {apiKey && (
          <>
            <DialogHeader>
              <DialogTitle>{apiKey.name}</DialogTitle>
              <DialogDescription className="font-mono">kbk_{apiKey.lookupPrefix}</DialogDescription>
            </DialogHeader>
            <div className="min-w-0 space-y-1">
              <ApiKeySummary apiKey={apiKey} lang={lang} />
            </div>
            {apiKey.kbCount > 0 && <ApiKeyKbs grantId={apiKey.grantId} />}
            {!apiKey.revokedAt && !expired(apiKey.expiresAt) && (
              <ApiKeyNextSteps
                serverUrl={serverUrl}
                ceiling={apiKey.allowMintChildren ? apiKey : null}
              />
            )}
            <ApiKeyChildren apiKey={apiKey} lang={lang} />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                className="min-h-[44px]"
                onClick={() => onOpenChange(false)}
              >
                {t("common:actions.close")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The chosen and created KBs of the key's grant, with their names. */
function ApiKeyKbs({ grantId }: { grantId: string }) {
  const { t } = useTranslation("settings");
  const kbs = useInfiniteQuery(
    orpc.mcpGrants.listAclMine.infiniteOptions({
      input: (cursor: string | null) => ({ grantId, limit: 50, cursor }),
      initialPageParam: null,
      getNextPageParam: (last) => last.nextCursor,
    }),
  );
  const { data, isPending, isError, hasNextPage, isFetchingNextPage } = kbs;
  const entries = data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="min-w-0 space-y-2" aria-labelledby={`api-key-kbs-${grantId}`}>
      <h3 id={`api-key-kbs-${grantId}`} className="text-sm font-medium">
        {t("apiKeys.kbsTitle")}
      </h3>
      {isPending ? <Skeleton className="h-10 w-full" /> : <ApiKeyKbNames entries={entries} />}
      {isError && <InlineRetry message={t("apiKeys.kbsLoadError")} onRetry={() => kbs.refetch()} />}
      <LoadMore
        onLoadMore={() => kbs.fetchNextPage()}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
      />
    </section>
  );
}

/**
 * A key's KBs by name; a KB the owner can no longer read (deleted or unshared)
 * has no name and shows a label, never its id. Exported for tests.
 */
export function ApiKeyKbNames({
  entries,
}: {
  entries: readonly { kbId: string; name: string | null }[];
}) {
  const { t } = useTranslation("settings");
  return (
    <ul className="space-y-0.5 text-xs">
      {entries.map((entry) => (
        <li key={entry.kbId} className="min-w-0 break-words">
          {entry.name ?? t("credentials.kbUnavailable")}
        </li>
      ))}
    </ul>
  );
}

/** The key's child MCP tokens, newest page last, each revocable on its own. */
function ApiKeyChildren({ apiKey, lang }: { apiKey: ApiKeyRow; lang: string }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<ChildTokenRow | null>(null);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const children = useInfiniteQuery(
    orpc.apiKeys.listChildrenMine.infiniteOptions({
      input: (cursor: string | null) => ({ apiKeyId: apiKey.id, limit: 20, cursor }),
      initialPageParam: null,
      getNextPageParam: (last) => last.nextCursor,
    }),
  );
  const revoke = useMutation(
    orpc.apiKeys.revokeChildMine.mutationOptions({
      onSuccess: () => {
        setPending(null);
        toast.success(t("apiKeys.revokeChildSuccess"));
      },
      onError: () => toast.error(t("credentials.revokeError")),
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.apiKeys.key() }),
    }),
  );
  const revokeAll = useMutation(
    orpc.apiKeys.revokeChildrenMine.mutationOptions({
      onSuccess: (result) => {
        setRevokeAllOpen(false);
        toast.success(
          result.children === 0
            ? t("apiKeys.revokeChildrenSuccessNone")
            : t("apiKeys.revokeChildrenSuccess", { count: result.children }),
        );
      },
      onError: () => toast.error(t("credentials.revokeError")),
      // Refreshes the key's live count and its children list alike.
      onSettled: () => queryClient.invalidateQueries({ queryKey: orpc.apiKeys.key() }),
    }),
  );
  const { data, isPending, isError, hasNextPage, isFetchingNextPage } = children;
  const rows = data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="min-w-0 space-y-2" aria-labelledby={`api-key-children-${apiKey.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`api-key-children-${apiKey.id}`} className="text-sm font-medium">
          {t("apiKeys.childrenTitle")}
        </h3>
        <ApiKeyRevokeChildren
          apiKey={apiKey}
          open={revokeAllOpen}
          onOpenChange={(open) => {
            if (open || !revokeAll.isPending) setRevokeAllOpen(open);
          }}
          isPending={revokeAll.isPending}
          onConfirm={(input) => revokeAll.mutate(input)}
        />
      </div>
      {isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full rounded-md" />
          <Skeleton className="h-14 w-full rounded-md" />
        </div>
      ) : isError && data === undefined ? (
        <InlineRetry message={t("credentials.listLoadError")} onRetry={() => children.refetch()} />
      ) : (
        <ChildTokenList rows={rows} lang={lang} onRevoke={setPending} />
      )}
      {isError && data !== undefined && (
        <InlineRetry
          message={t("credentials.listLoadError")}
          onRetry={() => children.fetchNextPage()}
        />
      )}
      <LoadMore
        onLoadMore={() => children.fetchNextPage()}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
      />
      <ConfirmDeleteDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !revoke.isPending) setPending(null);
        }}
        title={t("credentials.revokeTokenTitle")}
        description={t("credentials.revokeTokenDescription", { name: pending?.name ?? "" })}
        confirmToken={pending?.name ?? ""}
        typePrompt={t("credentials.revokeTypePrompt")}
        copyAriaLabel={t("credentials.copyConfirm")}
        inputMode="text"
        confirmLabel={t("credentials.revoke")}
        pendingLabel={t("credentials.revoking")}
        isPending={revoke.isPending}
        onConfirm={() => {
          if (pending) revoke.mutate({ apiKeyId: apiKey.id, tokenId: pending.id });
        }}
      />
    </section>
  );
}

/** Child token rows; exported for tests. */
export function ChildTokenList({
  rows,
  lang,
  onRevoke,
}: {
  rows: readonly ChildTokenRow[];
  lang: string;
  onRevoke: (row: ChildTokenRow) => void;
}) {
  const { t } = useTranslation("settings");
  const date = useDateFormat(lang);
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("apiKeys.noChildren")}</p>;
  }
  return (
    <ul className="divide-y rounded-md border">
      {rows.map((row) => {
        // A KB the owner can no longer read (deleted or unshared) has no name.
        const kb = row.kbId === null ? "—" : (row.kbName ?? t("credentials.kbUnavailable"));
        return (
          <li key={row.id} className="flex min-w-0 flex-wrap items-start gap-3 p-3">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate font-medium">{row.name}</span>
                <TokenStatePill revokedAt={row.revokedAt} expiresAt={row.expiresAt} />
              </p>
              <p className="text-xs break-words">
                {kb}
                {row.bits.length > 0 &&
                  `: ${row.bits.map((bit) => t(`credentials.picker.bits.${bit}.label`)).join(", ")}`}
              </p>
              <p className="text-xs">
                {t("credentials.toolGroupsSummary", { groups: groupsLabel(row.toolGroups, t) })}
              </p>
              <AuthoringModeSummary mode={row.authoringMode} />
              {row.allowCreate && <p className="text-xs">{t("apiKeys.childCanCreate")}</p>}
              {row.kbCount > 1 && (
                <p className="text-xs">
                  {t("apiKeys.childCreatedKbs", { count: row.kbCount - 1 })}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {row.revokedAt
                  ? t("credentials.revoked")
                  : row.expiresAt === null
                    ? t("credentials.neverExpires")
                    : t(expired(row.expiresAt) ? "apiKeys.expired" : "credentials.expires", {
                        date: date(row.expiresAt),
                      })}
              </p>
            </div>
            {!row.revokedAt && (
              <Button
                variant="outline"
                className="min-h-[44px]"
                aria-label={t("credentials.revokeFor", { name: row.name })}
                onClick={() => onRevoke(row)}
              >
                {t("credentials.revoke")}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Revoke all tokens" of one key (live or revoked) → type-to-confirm. Shown
 * only while the key has live children; exported for tests.
 */
export function ApiKeyRevokeChildren({
  apiKey,
  open,
  onOpenChange,
  isPending,
  onConfirm,
}: {
  apiKey: ApiKeyRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPending: boolean;
  onConfirm: (input: ApiKeyRevokeChildrenInput) => void;
}) {
  const { t } = useTranslation("settings");
  if (apiKey.liveChildren === 0 && !open) return null;
  return (
    <>
      {apiKey.liveChildren > 0 && (
        <Button
          type="button"
          variant="outline"
          className="min-h-[44px]"
          onClick={() => onOpenChange(true)}
        >
          {t("apiKeys.revokeChildren")}
        </Button>
      )}
      <ConfirmDeleteDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t("apiKeys.revokeChildrenTitle")}
        description={t("apiKeys.revokeChildrenDescription", {
          name: apiKey.name,
          count: apiKey.liveChildren,
        })}
        confirmToken={apiKey.name}
        typePrompt={t("credentials.revokeTypePrompt")}
        copyAriaLabel={t("credentials.copyConfirm")}
        inputMode="text"
        confirmLabel={t("apiKeys.revokeChildren")}
        pendingLabel={t("credentials.revoking")}
        isPending={isPending}
        onConfirm={() => onConfirm({ apiKeyId: apiKey.id })}
      />
    </>
  );
}

/** The revoke toast for what the server reports it revoked, in words. */
export function apiKeyRevokeToast(
  t: TFunction<"settings">,
  revoked: { children: number },
  asked: { liveChildren: number; revokeChildren: boolean },
): string {
  if (revoked.children > 0) return t("apiKeys.revokeSuccess", { count: revoked.children });
  return asked.liveChildren > 0 && !asked.revokeChildren
    ? t("apiKeys.revokeSuccessKeptTokens")
    : t("apiKeys.revokeSuccessNoTokens");
}

/**
 * Revoke one key → type-to-confirm, with "Also revoke its N tokens"
 * (pre-selected from the key's childrenEndWithKey until changed, hidden when
 * it has none). Exported for tests; the API keys page is its only caller.
 */
export function ApiKeyRevokeDialog({
  apiKey,
  choice,
  onChoiceChange,
  onOpenChange,
  isPending,
  onConfirm,
}: {
  apiKey: ApiKeyRow | null;
  /** "Also revoke its tokens" as changed by the user; null = the key's own setting. */
  choice: boolean | null;
  onChoiceChange: (next: boolean) => void;
  onOpenChange: (open: boolean) => void;
  isPending: boolean;
  onConfirm: (input: ApiKeyRevokeInput) => void;
}) {
  const { t } = useTranslation("settings");
  const id = useId();
  const name = apiKey?.name ?? "";
  const count = apiKey?.liveChildren ?? 0;
  const revokeChildren = choice ?? apiKey?.childrenEndWithKey ?? false;
  return (
    <ConfirmDeleteDialog
      open={apiKey !== null}
      onOpenChange={onOpenChange}
      title={t("apiKeys.revokeTitle")}
      description={
        count === 0
          ? t("apiKeys.revokeDescriptionNoTokens", { name })
          : revokeChildren
            ? t("apiKeys.revokeDescription", { name, count })
            : t("apiKeys.revokeDescriptionKeepTokens", { name, count })
      }
      confirmToken={name}
      typePrompt={t("credentials.revokeTypePrompt")}
      copyAriaLabel={t("credentials.copyConfirm")}
      inputMode="text"
      confirmLabel={t("credentials.revoke")}
      pendingLabel={t("credentials.revoking")}
      isPending={isPending}
      onConfirm={() => {
        if (apiKey) onConfirm({ id: apiKey.id, revokeChildren });
      }}
    >
      {/* The count is a snapshot: a key that can mint may mint a token while this
          dialog is open, so the choice is offered whenever it could matter. */}
      {(count > 0 || apiKey?.allowMintChildren) && (
        <CheckRow
          id={`${id}-revoke-children`}
          checked={revokeChildren}
          disabled={isPending}
          onToggle={() => onChoiceChange(!revokeChildren)}
          label={
            count > 0
              ? t("apiKeys.revokeAlsoChildren", { count })
              : t("apiKeys.revokeAlsoAnyChildren")
          }
        />
      )}
    </ConfirmDeleteDialog>
  );
}
