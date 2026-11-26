import { env } from "@knowledge-base/env/web";
import { toast } from "@knowledge-base/ui/components/sileo";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { InlineRetry } from "@/components/inline-retry";

import { ApiKeyCreateDialog } from "@/components/kb/api-key-create-dialog";
import {
  ApiKeyDetailsDialog,
  ApiKeyList,
  ApiKeyRevokeDialog,
  type ApiKeyRow,
  apiKeyRevokeToast,
} from "@/components/kb/api-key-list";
import { RestApiLinks } from "@/components/kb/api-key-next-steps";
import { LoadMore } from "@/components/load-more";
import { pageHead } from "@/lib/page-title";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/_auth/settings/api-keys")({
  staticData: { pendingShape: "list" },
  head: ({ match }) =>
    pageHead(
      match.context.i18n.t("settings:navApiKeys"),
      match.context.i18n.t("nav:items.settings"),
    ),
  component: ApiKeySettings,
});

/**
 * The signed-in user's own REST API keys (`apiKeys.*Mine` only). A key is a
 * control-plane credential for `/api/v1`, separate from MCP tokens.
 */
function ApiKeySettings() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [details, setDetails] = useState<ApiKeyRow | null>(null);
  const [pending, setPending] = useState<ApiKeyRow | null>(null);
  // "Also revoke its tokens" once changed; null = the key's own setting.
  const [revokeChildren, setRevokeChildren] = useState<boolean | null>(null);
  const askRevoke = (key: ApiKeyRow) => {
    setRevokeChildren(null);
    setPending(key);
  };
  const keys = useInfiniteQuery(
    orpc.apiKeys.listMine.infiniteOptions({
      input: (cursor: string | null) => ({ limit: 20, cursor }),
      initialPageParam: null,
      getNextPageParam: (last) => last.nextCursor,
    }),
  );
  const revoke = useMutation(
    orpc.apiKeys.revokeMine.mutationOptions({
      onSuccess: (result, input) => {
        toast.success(
          apiKeyRevokeToast(t, result, {
            liveChildren: pending?.liveChildren ?? 0,
            revokeChildren: input.revokeChildren ?? false,
          }),
        );
        setPending(null);
      },
      // Denial keeps the row as-is; the list only changes after a server refetch.
      onError: () => toast.error(t("settings:credentials.revokeError")),
      onSettled: () =>
        Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.apiKeys.key() }),
          queryClient.invalidateQueries({ queryKey: orpc.mcpGrants.key() }),
        ]),
    }),
  );

  if (keys.isPending) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
    );
  }
  if ((keys.isError && keys.data === undefined) || isQueryAccessError(keys.error)) {
    return (
      <InlineRetry message={t("settings:apiKeys.listLoadError")} onRetry={() => keys.refetch()} />
    );
  }

  // The live (possibly refetched) row, so details follow a revoke or new token.
  const rows = keys.data?.pages.flatMap((page) => page.items) ?? [];
  const detailsRow = details ? (rows.find((row) => row.id === details.id) ?? details) : null;
  return (
    <>
      <div className="mb-6 space-y-2 text-sm text-muted-foreground">
        <p>{t("settings:apiKeys.intro")}</p>
        <p>
          {t("settings:apiKeys.introMcp")}{" "}
          <Link
            to="/$lang/settings/mcp"
            params={{ lang }}
            className="inline-flex min-h-[44px] items-center font-medium text-foreground underline underline-offset-4"
          >
            {t("settings:navMcp")}
          </Link>
        </p>
        <RestApiLinks serverUrl={env.VITE_SERVER_URL} />
      </div>
      {keys.isError && (
        <InlineRetry
          variant="destructive"
          message={t("settings:apiKeys.listLoadError")}
          onRetry={() => keys.refetch()}
        />
      )}
      <ApiKeyList
        lang={lang}
        keys={rows}
        onCreate={() => setCreateOpen(true)}
        onDetails={setDetails}
        onRevoke={askRevoke}
        footer={
          <LoadMore
            onLoadMore={() => keys.fetchNextPage()}
            hasNextPage={keys.hasNextPage}
            isFetchingNextPage={keys.isFetchingNextPage}
          />
        }
      />
      <ApiKeyCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        serverUrl={env.VITE_SERVER_URL}
      />
      <ApiKeyDetailsDialog
        apiKey={detailsRow}
        lang={lang}
        serverUrl={env.VITE_SERVER_URL}
        onOpenChange={(open) => {
          if (!open) setDetails(null);
        }}
      />
      <ApiKeyRevokeDialog
        apiKey={pending}
        choice={revokeChildren}
        onChoiceChange={setRevokeChildren}
        onOpenChange={(open) => {
          if (!open && !revoke.isPending) setPending(null);
        }}
        isPending={revoke.isPending}
        onConfirm={(input) => revoke.mutate(input)}
      />
    </>
  );
}
