import { Button } from "@knowledge-base/ui/components/button";
import { toast } from "@knowledge-base/ui/components/sileo";
import { useInfiniteQuery, useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { Help } from "@/components/help";
import { InlineRetry } from "@/components/inline-retry";
import { ControlError, describeControlError } from "@/components/kb/profile-panel";
import {
  SealedAddSecretDialog,
  type SealedKbLike,
  type SealedTarget,
} from "@/components/kb/sealed/sealed-add-secret-dialog";
import { SealedGrantDialog } from "@/components/kb/sealed/sealed-grant-dialog";
import {
  revokeGrantPayload,
  type SealedGrant,
  type SealedUsage,
  type SealedValue,
  shortKeyId,
} from "@/components/kb/sealed/sealed-logic";
import {
  SealedValueCard,
  SealedValueCardSkeleton,
  sealedValueName,
  type UsageState,
} from "@/components/kb/sealed/sealed-value-card";
import { LoadMore } from "@/components/load-more";
import { useKbAccessLoss, useRetireSealedOnDenied } from "@/hooks/use-kb-editor";
import { useKbMutationSession } from "@/hooks/use-kb-mutation-session";
import { useRenewableAttemptKey } from "@/hooks/use-renewable-attempt-key";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";

export { SealedReferenceReveal } from "@/components/kb/sealed/sealed-add-secret-dialog";

/** Sealed control is exact-owner only: a manager who is not the owner never sees it. */
export function sealedControls(bits: readonly string[], isOwner: boolean): { visible: boolean } {
  return { visible: isOwner && bits.includes("manage") };
}

/** The empty state: what sealed values are for, with an example, and the first step. */
export function SealedEmptyState({ onAdd }: { onAdd: () => void }) {
  const { t } = useTranslation("kb");
  return (
    <div
      data-testid="sealed-empty"
      className="min-w-0 space-y-3 rounded-lg border border-dashed p-4 sm:p-6"
    >
      <h3 className="font-semibold">{t("settings.sealed.empty.title")}</h3>
      <p className="text-sm">{t("settings.sealed.empty.body", { example: "{{sealed:v1:…}}" })}</p>
      <p className="text-sm text-muted-foreground">{t("settings.sealed.empty.example")}</p>
      <Button type="button" data-testid="sealed-add" className="min-h-[44px]" onClick={onAdd}>
        <Plus aria-hidden="true" className="size-4" />
        {t("settings.sealed.add")}
      </Button>
    </div>
  );
}

/** The value list as plain props, so it renders the same with or without live queries. */
export function SealedValueList({
  values,
  usage,
  usageState,
  kbId,
  lang,
  now,
  onGiveAccess,
  onRevokeGrant,
  onDelete,
}: {
  values: readonly SealedValue[];
  usage: readonly SealedUsage[] | undefined;
  usageState: UsageState;
  kbId: string;
  lang: string;
  now: Date;
  onGiveAccess: (value: SealedValue) => void;
  onRevokeGrant: (value: SealedValue, grant: SealedGrant) => void;
  onDelete: (value: SealedValue) => void;
}) {
  const { t } = useTranslation("kb");
  const byRecord = new Map(usage?.map((entry) => [entry.recordId, entry]));
  return (
    <ul aria-label={t("settings.sealed.list.label")} className="min-w-0 space-y-4">
      {values.map((value) => (
        <SealedValueCard
          key={value.recordId}
          value={value}
          kbId={kbId}
          lang={lang}
          now={now}
          usage={byRecord.get(value.recordId)}
          // A value added after the usage scan has simply not been looked up yet.
          usageState={
            usageState.status === "ready" && !byRecord.has(value.recordId)
              ? { status: "pending" }
              : usageState
          }
          onGiveAccess={() => onGiveAccess(value)}
          onRevokeGrant={(grant) => onRevokeGrant(value, grant)}
          onDelete={() => onDelete(value)}
        />
      ))}
    </ul>
  );
}

type Denied = { onDenied?: () => void };
type RevokeTarget = { value: SealedValue; grant: SealedGrant };

/**
 * Owner sealed controls: a list of named values (reference, the documents
 * that use it, the tokens that can read it), Add secret, Give access, inline
 * revoke and Delete value. A saved value is never fetched or shown again.
 * `onInsertReference` (kb-workspace) adds "Insert into document" after saving.
 */
export function SealedPanel({
  kb,
  onDenied,
  onInsertReference,
}: {
  kb: SealedKbLike;
  onInsertReference?: (reference: string) => void;
} & Denied) {
  if (!sealedControls(kb.capabilities, kb.isOwner).visible) return null;
  return <SealedPanelBody kb={kb} onDenied={onDenied} onInsertReference={onInsertReference} />;
}

function SealedPanelBody({
  kb,
  onDenied,
  onInsertReference,
}: {
  kb: SealedKbLike;
  onInsertReference?: (reference: string) => void;
} & Denied) {
  const { t, i18n } = useTranslation("kb");
  const lang = i18n.language;
  const queryClient = useQueryClient();
  const session = useKbMutationSession();
  const [adding, setAdding] = useState(false);
  const [granting, setGranting] = useState<SealedTarget | null>(null);
  const [revoking, setRevoking] = useState<RevokeTarget | null>(null);
  const [deleting, setDeleting] = useState<SealedValue | null>(null);
  const revokeAttempt = useRenewableAttemptKey();
  const deleteAttempt = useRenewableAttemptKey();

  // A refused token-picker read (Give access) retires the whole panel too.
  const [pickerDenied, setPickerDenied] = useState(false);
  // Owner-only metadata is never kept once nothing shows it (gcTime 0), and once
  // a sealed read is refused the reads stop, so retired data is not fetched back.
  const listQuery = useInfiniteQuery(
    orpc.kbSealed.list.infiniteOptions({
      input: (cursor: string | null) => ({ kbId: kb.id, limit: 20, cursor: cursor ?? undefined }),
      initialPageParam: null,
      getNextPageParam: (last) => last.nextCursor,
      gcTime: 0,
      enabled: !pickerDenied,
    }),
  );
  const { data, error: listError, isPending, isError, hasNextPage, isFetchingNextPage } = listQuery;
  // One bounded usage scan per loaded page, for exactly the values it shows.
  const usageQueries = useQueries({
    queries: (data?.pages ?? [])
      .filter((page) => page.items.length > 0)
      .map((page) => ({
        ...orpc.kbSealed.usage.queryOptions({
          input: { kbId: kb.id, recordIds: page.items.map((item) => item.recordId) },
        }),
        gcTime: 0,
        enabled: !pickerDenied && !isQueryAccessError(listError),
      })),
  });
  const usageErrors = usageQueries.map((query) => query.error);
  // A refused owner-only read (lost ownership, 2FA turned off, signed out)
  // hides and drops what is cached right away, closes the dialogs, and
  // re-checks the KB permission.
  useKbAccessLoss(kb.id, [listError, ...usageErrors]);
  const readDenied =
    pickerDenied || isQueryAccessError(listError) || usageErrors.some(isQueryAccessError);
  useRetireSealedOnDenied(kb.id, readDenied);
  const values = readDenied ? [] : (data?.pages.flatMap((page) => page.items) ?? []);
  const usageList = usageQueries.flatMap((query) => query.data?.usage ?? []);
  const usageComplete =
    usageQueries.length > 0 && usageQueries.every((query) => query.data?.complete === true);

  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.kbSealed.key() });
  // A refused action may mean the sealed gate itself now refuses (2FA off,
  // ownership gone) even while the KB permission still says owner: re-read the
  // list, whose refusal retires the panel (readDenied above).
  const sealedDenied = () => {
    onDenied?.();
    void listQuery.refetch();
  };
  const denied = (error: unknown) => {
    if (describeControlError(error) === "denied") sealedDenied();
  };
  const revokeGrant = useMutation(
    orpc.kbSealed.revokeGrant.mutationOptions({
      onSuccess: () => {
        if (!session.current) return;
        revokeAttempt.renew();
        setRevoking(null);
        toast.success(t("settings.sealed.revoke.done"));
        void refresh();
      },
      onError: (error) => {
        if (session.current) denied(error);
      },
    }),
  );
  const deleteValue = useMutation(
    orpc.kbSealed.revoke.mutationOptions({
      onSuccess: () => {
        if (!session.current) return;
        deleteAttempt.renew();
        setDeleting(null);
        toast.success(t("settings.sealed.delete.done"));
        void refresh();
      },
      onError: (error) => {
        if (session.current) denied(error);
      },
    }),
  );

  // A scan that did not finish is "couldn't check", never "not used".
  const usageState: UsageState = usageQueries.some((query) => query.isPending)
    ? { status: "pending" }
    : !usageComplete
      ? {
          status: "error",
          onRetry: () => {
            for (const query of usageQueries)
              if (query.data?.complete !== true) void query.refetch();
          },
        }
      : { status: "ready" };
  const unnamed = t("settings.sealed.list.unnamed");
  // Client-only page (no SSR): "access ends in…" is relative to this render.
  const now = new Date();
  const deletingUsage = deleting
    ? usageList.find((entry) => entry.recordId === deleting.recordId)
    : undefined;

  return (
    <section
      data-testid="sealed-panel"
      aria-labelledby="kb-sealed-title"
      className="min-w-0 space-y-6"
    >
      <header className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-1.5">
            <h2 id="kb-sealed-title" className="text-lg font-semibold">
              {t("settings.sealed.title")}
            </h2>
            <Help title={t("settings.sealed.title")}>
              <p>{t("settings.sealed.help", { example: "{{sealed:v1:…}}" })}</p>
            </Help>
          </div>
          <p className="text-sm text-muted-foreground">{t("settings.sealed.description")}</p>
        </div>
        {values.length > 0 && (
          <Button
            type="button"
            data-testid="sealed-add"
            className="min-h-[44px] shrink-0"
            onClick={() => setAdding(true)}
          >
            <Plus aria-hidden="true" className="size-4" />
            {t("settings.sealed.add")}
          </Button>
        )}
      </header>

      {readDenied ? (
        <p data-testid="sealed-read-denied" role="alert" className="text-sm text-destructive">
          {t("settings.sealed.list.denied")}
        </p>
      ) : isPending ? (
        <ul className="min-w-0 space-y-4" aria-busy="true">
          <SealedValueCardSkeleton />
          <SealedValueCardSkeleton />
        </ul>
      ) : isError && values.length === 0 ? (
        <InlineRetry
          message={t("settings.sealed.list.loadError")}
          onRetry={() => listQuery.refetch()}
        />
      ) : values.length === 0 ? (
        <SealedEmptyState onAdd={() => setAdding(true)} />
      ) : (
        <>
          <SealedValueList
            values={values}
            usage={usageList}
            usageState={usageState}
            kbId={kb.id}
            lang={lang}
            now={now}
            onGiveAccess={(value) =>
              setGranting({ reference: value.reference, label: value.label, grants: value.grants })
            }
            onRevokeGrant={(value, grant) => {
              // A new target is a new operation; retries inside one dialog reuse the key.
              revokeAttempt.renew();
              revokeGrant.reset();
              setRevoking({ value, grant });
            }}
            onDelete={(value) => {
              deleteAttempt.renew();
              deleteValue.reset();
              setDeleting(value);
            }}
          />
          {isError && (
            <InlineRetry
              message={t("settings.sealed.list.loadError")}
              onRetry={() =>
                listQuery.isFetchNextPageError ? listQuery.fetchNextPage() : listQuery.refetch()
              }
            />
          )}
          <LoadMore
            onLoadMore={() => listQuery.fetchNextPage()}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            label={t("settings.sealed.list.loadMore")}
          />
        </>
      )}

      <SealedAddSecretDialog
        kb={kb}
        open={adding && !readDenied}
        onOpenChange={setAdding}
        onSaved={() => void refresh()}
        onGiveAccess={setGranting}
        onInsertReference={onInsertReference}
        onDenied={sealedDenied}
      />
      <SealedGrantDialog
        kb={kb}
        target={readDenied ? null : granting}
        lang={lang}
        onOpenChange={(open) => !open && setGranting(null)}
        onGranted={() => {
          toast.success(t("settings.sealed.grantDialog.done"));
          void refresh();
        }}
        onDenied={sealedDenied}
        onReadDenied={() => setPickerDenied(true)}
      />
      <ConfirmDeleteDialog
        open={revoking !== null && !readDenied}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("settings.sealed.revoke.title", {
          token: revoking?.grant.tokenName ?? t("settings.sealed.list.removedToken"),
          name: revoking ? sealedValueName(revoking.value, unnamed) : "",
        })}
        description={t("settings.sealed.revoke.description", {
          keyId: revoking ? `${shortKeyId(revoking.grant.recipientKeyId)}…` : "",
        })}
        confirmToken="REVOKE"
        typePrompt={t("settings.sealed.revoke.prompt")}
        copyAriaLabel={t("settings.members.copyToken")}
        inputMode="text"
        confirmLabel={t("settings.sealed.revoke.action")}
        pendingLabel={t("settings.sealed.revoke.pending")}
        isPending={revokeGrant.isPending}
        onConfirm={() =>
          revoking &&
          revokeGrant.mutate(
            revokeGrantPayload({
              kbId: kb.id,
              reference: revoking.value.reference,
              grant: revoking.grant,
              idempotencyKey: revokeAttempt.key,
            }),
          )
        }
      >
        <ControlError error={revokeGrant.error} testId="sealed-error" />
      </ConfirmDeleteDialog>
      <ConfirmDeleteDialog
        open={deleting !== null && !readDenied}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("settings.sealed.delete.title", {
          name: deleting ? sealedValueName(deleting, unnamed) : "",
        })}
        description={t("settings.sealed.delete.description")}
        confirmToken="DELETE"
        typePrompt={t("settings.sealed.delete.prompt")}
        copyAriaLabel={t("settings.members.copyToken")}
        inputMode="text"
        confirmLabel={t("settings.sealed.delete.action")}
        pendingLabel={t("settings.sealed.delete.pending")}
        isPending={deleteValue.isPending}
        onConfirm={() =>
          deleting &&
          deleteValue.mutate({
            kbId: kb.id,
            reference: deleting.reference,
            idempotencyKey: deleteAttempt.key,
          })
        }
      >
        {deleting && !usageComplete && (
          <p data-testid="sealed-delete-usage-unknown" className="text-sm">
            {t("settings.sealed.delete.usageUnknown")}
          </p>
        )}
        {usageComplete && deletingUsage && deletingUsage.paths.length > 0 && (
          <div data-testid="sealed-delete-usage" className="min-w-0 space-y-1 text-sm">
            <p>{t("settings.sealed.delete.docsWarning")}</p>
            <ul className="min-w-0 list-disc pl-5">
              {deletingUsage.paths.map((path) => (
                <li key={path} className="break-all">
                  {path}
                </li>
              ))}
            </ul>
          </div>
        )}
        <ControlError error={deleteValue.error} testId="sealed-error" />
      </ConfirmDeleteDialog>
    </section>
  );
}
