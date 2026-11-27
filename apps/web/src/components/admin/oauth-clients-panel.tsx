import { Button } from "@knowledge-base/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@knowledge-base/ui/components/card";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { toast } from "@knowledge-base/ui/components/sileo";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { LoadMore } from "@/components/load-more";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";

export function OAuthClientsPanel() {
  const { t, i18n } = useTranslation("admin");
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const {
    data,
    error,
    isPending,
    isError,
    isFetchNextPageError,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery(
    orpc.oauthClients.list.infiniteOptions({
      input: (cursor: string | null) => ({ limit: 20, cursor: cursor ?? undefined }),
      initialPageParam: null,
      getNextPageParam: (last) => last.nextCursor,
      gcTime: 0,
    }),
  );
  const remove = useMutation(
    orpc.oauthClients.delete.mutationOptions({
      onError: (err) => {
        if (isQueryAccessError(err)) {
          setTarget(null);
          recheckList();
        }
      },
      onSuccess: () => {
        setTarget(null);
        void queryClient.invalidateQueries({ queryKey: orpc.oauthClients.list.key() });
        toast.success(t("oauthClients.deleted"));
      },
    }),
  );
  const recheckList = () => {
    void refetch().then((result) => {
      if (result?.isSuccess) {
        remove.reset();
      }
    });
  };
  const denied = isQueryAccessError(error) || isQueryAccessError(remove.error);
  const items = denied ? [] : (data?.pages.flatMap((page) => page.items) ?? []);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("oauthClients.title")}</CardTitle>
        <CardDescription>{t("oauthClients.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            {items.map((client) => (
              <div key={client.id} className="space-y-2 rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong>{client.name || client.clientId}</strong>
                  <span className="rounded border px-2 text-sm">
                    {t(client.dynamic ? "oauthClients.dynamic" : "oauthClients.registered")}
                  </span>
                </div>
                <CopyField
                  value={client.clientId}
                  copyLabel={t("oauthClients.copyId")}
                  className="font-mono"
                />
                <p className="text-sm text-muted-foreground">
                  {t("oauthClients.created", {
                    date: client.createdAt
                      ? new Intl.DateTimeFormat(i18n.language).format(new Date(client.createdAt))
                      : t("oauthClients.unknownDate"),
                  })}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("oauthClients.counts", {
                    grants: client.activeGrantCount,
                    tokens: client._count.oauthAccessTokens + client._count.oauthRefreshTokens,
                  })}
                </p>
                <Button
                  type="button"
                  variant="destructive"
                  className="min-h-[44px]"
                  onClick={() => {
                    remove.reset();
                    setTarget({ id: client.id, name: client.name || client.clientId });
                  }}
                >
                  {t("oauthClients.delete")}
                </Button>
              </div>
            ))}
            {!isError && !denied && items.length === 0 && <p>{t("oauthClients.empty")}</p>}
            {isError && (
              <InlineRetry
                message={t("oauthClients.loadFailed")}
                onRetry={() => (isFetchNextPageError ? void fetchNextPage() : recheckList())}
              />
            )}
            {!denied && (
              <LoadMore
                hasNextPage={!!hasNextPage}
                isFetchingNextPage={isFetchingNextPage}
                onLoadMore={() => void fetchNextPage()}
              />
            )}
          </>
        )}
      </CardContent>
      <ConfirmDeleteDialog
        open={target !== null && !denied}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        title={t("oauthClients.deleteTitle")}
        description={t("oauthClients.deleteDescription", { name: target?.name ?? "" })}
        confirmToken="DELETE"
        typePrompt={t("oauthClients.deletePrompt")}
        copyAriaLabel={t("oauthClients.copyConfirmation")}
        isPending={remove.isPending}
        onConfirm={() => {
          if (target) remove.mutate({ id: target.id });
        }}
      >
        {remove.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t("oauthClients.deleteFailed")}
          </p>
        )}
      </ConfirmDeleteDialog>
    </Card>
  );
}
