import { Button } from "@knowledge-base/ui/components/button";
import { toast } from "@knowledge-base/ui/components/sileo";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import {
  CredentialList,
  editTargetFromGrant,
  editTargetFromToken,
  type GrantRow,
  PatCreateDialog,
  type TokenRow,
} from "@/components/kb/credential-list";
import { GrantEditSheet, type GrantEditTarget } from "@/components/kb/grant-edit-sheet";
import { LoadMore } from "@/components/load-more";
import { pageHead } from "@/lib/page-title";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/settings/mcp")({
  // Set by the password-reset success screen: the reset signed out every
  // browser session but left tokens and connected apps working.
  validateSearch: (search: Record<string, unknown>): { review?: "password-reset" } =>
    search.review === "password-reset" ? { review: "password-reset" } : {},
  head: ({ match }) =>
    pageHead(match.context.i18n.t("settings:navMcp"), match.context.i18n.t("nav:items.settings")),
  component: McpCredentialSettings,
});

type Pending = { kind: "token"; row: TokenRow } | { kind: "grant"; row: GrantRow } | null;

/**
 * The signed-in user's own PATs and OAuth grants (`listMine`/`updateMine`/
 * `revokeMine` only — no admin or cross-user surface). MCP is always on.
 */
function McpCredentialSettings() {
  const { lang } = Route.useParams();
  const { review } = Route.useSearch();
  const { t } = useTranslation(["settings", "common"]);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [editing, setEditing] = useState<GrantEditTarget | null>(null);
  const tokens = useInfiniteQuery(
    orpc.mcpTokens.listMine.infiniteOptions({
      input: (cursor: string | null) => ({ limit: 20, cursor }),
      initialPageParam: null,
      getNextPageParam: (last) => last.nextCursor,
    }),
  );
  const grants = useInfiniteQuery(
    orpc.mcpGrants.listMine.infiniteOptions({
      input: (cursor: string | null) => ({ limit: 20, cursor, kind: "OAUTH" }),
      initialPageParam: null,
      getNextPageParam: (last) => last.nextCursor,
    }),
  );
  const onRevoked = {
    onSuccess: async () => {
      setPending(null);
      toast.success(t("settings:credentials.revokeSuccess"));
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.mcpTokens.key() }),
        queryClient.invalidateQueries({ queryKey: orpc.mcpGrants.key() }),
      ]);
    },
    // Denial keeps the row as-is; the list only changes after a server refetch.
    onError: () => toast.error(t("settings:credentials.revokeError")),
  };
  const revokeToken = useMutation(orpc.mcpTokens.revokeMine.mutationOptions(onRevoked));
  const revokeGrant = useMutation(orpc.mcpGrants.revokeMine.mutationOptions(onRevoked));
  // Review after a password reset: the server counts what is usable now
  // (the lists also hold revoked history) and revokes it all in bounded
  // batches, answering only once every batch is done.
  const reviewing = review === "password-reset";
  const active = useQuery({
    ...orpc.mcpGrants.countActiveMine.queryOptions(),
    enabled: reviewing,
  });
  const revokeAll = useMutation(
    orpc.mcpGrants.revokeAllMine.mutationOptions({
      onSuccess: async () => {
        setRevokeAllOpen(false);
        toast.success(t("settings:credentials.revokeAllSuccess"));
      },
      onError: () => toast.error(t("settings:credentials.revokeAllError")),
      onSettled: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.mcpTokens.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.mcpGrants.key() }),
        ]),
    }),
  );

  if (tokens.isPending || grants.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-20 w-full rounded-md" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-20 w-full rounded-md" />
      </div>
    );
  }
  if (
    (tokens.isError && tokens.data === undefined) ||
    (grants.isError && grants.data === undefined) ||
    isQueryAccessError(tokens.error) ||
    isQueryAccessError(grants.error)
  ) {
    return (
      <InlineRetry
        message={t("settings:credentials.listLoadError")}
        onRetry={() => {
          tokens.refetch();
          grants.refetch();
        }}
      />
    );
  }

  const confirmName =
    pending?.kind === "token" ? pending.row.name : (pending?.row.clientId ?? pending?.row.id ?? "");
  const { data: activeCounts } = active;
  const hasLive = activeCounts !== undefined && activeCounts.tokens + activeCounts.apps > 0;
  return (
    <>
      {reviewing && active.isError && (
        // The review must not silently vanish when its count fails to load.
        <InlineRetry
          variant="destructive"
          className="mb-6"
          message={t("settings:credentials.resetReviewLoadError")}
          onRetry={() => active.refetch()}
        />
      )}
      {reviewing && activeCounts !== undefined && (
        <div
          role="status"
          className="mb-6 rounded-md border border-yellow-300 bg-yellow-100 px-4 py-3 text-sm text-yellow-900 dark:border-yellow-700 dark:bg-yellow-950 dark:text-yellow-100"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            <ShieldAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
            <div className="flex-1 space-y-1">
              <p className="font-medium">{t("settings:credentials.resetReviewTitle")}</p>
              <p>
                {hasLive
                  ? t("settings:credentials.resetReviewMessage")
                  : t("settings:credentials.resetReviewNone")}
              </p>
            </div>
            {hasLive && (
              <Button
                variant="destructive"
                className="min-h-[44px]"
                onClick={() => setRevokeAllOpen(true)}
              >
                {t("settings:credentials.revokeAll")}
              </Button>
            )}
          </div>
        </div>
      )}
      {(tokens.isError || grants.isError) && (
        <InlineRetry
          variant="destructive"
          message={t("settings:credentials.listLoadError")}
          onRetry={() => {
            void tokens.refetch();
            void grants.refetch();
          }}
        />
      )}
      <CredentialList
        lang={lang}
        tokens={tokens.data?.pages.flatMap((page) => page.items) ?? []}
        grants={grants.data?.pages.flatMap((page) => page.items) ?? []}
        onCreate={() => setCreateOpen(true)}
        onEditToken={(row) => setEditing(editTargetFromToken(row))}
        onEditGrant={(row) => setEditing(editTargetFromGrant(row))}
        onRevokeToken={(row) => setPending({ kind: "token", row })}
        onRevokeGrant={(row) => setPending({ kind: "grant", row })}
        tokensFooter={
          <LoadMore
            onLoadMore={() => tokens.fetchNextPage()}
            hasNextPage={tokens.hasNextPage}
            isFetchingNextPage={tokens.isFetchingNextPage}
          />
        }
        grantsFooter={
          <LoadMore
            onLoadMore={() => grants.fetchNextPage()}
            hasNextPage={grants.hasNextPage}
            isFetchingNextPage={grants.isFetchingNextPage}
          />
        }
      />
      <PatCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
      <GrantEditSheet
        target={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      />
      <ConfirmDeleteDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={
          pending?.kind === "grant"
            ? t("settings:credentials.revokeGrantTitle")
            : t("settings:credentials.revokeTokenTitle")
        }
        description={
          pending?.kind === "grant"
            ? t("settings:credentials.revokeGrantDescription", { name: confirmName })
            : t("settings:credentials.revokeTokenDescription", { name: confirmName })
        }
        confirmToken={confirmName}
        typePrompt={t("settings:credentials.revokeTypePrompt")}
        copyAriaLabel={t("settings:credentials.copyConfirm")}
        inputMode="text"
        confirmLabel={t("settings:credentials.revoke")}
        pendingLabel={t("settings:credentials.revoking")}
        isPending={revokeToken.isPending || revokeGrant.isPending}
        onConfirm={() => {
          if (pending?.kind === "token") revokeToken.mutate({ id: pending.row.id });
          else if (pending?.kind === "grant") revokeGrant.mutate({ id: pending.row.id });
        }}
      />
      <ConfirmDeleteDialog
        open={revokeAllOpen}
        onOpenChange={(open) => {
          if (!revokeAll.isPending) setRevokeAllOpen(open);
        }}
        title={t("settings:credentials.revokeAllTitle")}
        description={t("settings:credentials.revokeAllDescription")}
        confirmToken={t("settings:credentials.revokeAllConfirmToken")}
        typePrompt={t("settings:credentials.revokeAllTypePrompt")}
        copyAriaLabel={t("settings:credentials.revokeAllCopyConfirm")}
        inputMode="text"
        confirmLabel={t("settings:credentials.revokeAll")}
        pendingLabel={t("settings:credentials.revoking")}
        isPending={revokeAll.isPending}
        onConfirm={() => {
          revokeAll.mutate({});
        }}
      />
    </>
  );
}
