import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@knowledge-base/ui/components/sheet";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { TextField } from "@knowledge-base/ui/components/text-field";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useForm } from "@tanstack/react-form";
import {
  type QueryClient,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { IndexSettingsPanel } from "@/components/kb/index-settings-panel";
import { MirrorPanel, mirrorControls } from "@/components/kb/mirror-panel";
import {
  ControlError,
  controlErrorCode,
  describeControlError,
  ProfilePanel,
} from "@/components/kb/profile-panel";
import { SealedPanel, sealedControls } from "@/components/kb/sealed-panel";
import { LoadMore } from "@/components/load-more";
import { QueryBoundary } from "@/components/query-boundary";
import { WideContent } from "@/components/wide-content";
import { useAuthSession } from "@/hooks/use-auth-session";
import {
  type Capability,
  clearKbPrivateQueries,
  recheckKbAccess,
  useKbAccessLoss,
} from "@/hooks/use-kb-editor";
import { useKbMutationSession } from "@/hooks/use-kb-mutation-session";
import { useRenewableAttemptKey } from "@/hooks/use-renewable-attempt-key";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";

type KbGet = Awaited<ReturnType<AppRouterClient["kbs"]["get"]>>;
type SettingsKb = KbGet["kb"];
type MemberRow = {
  shareId: string;
  userId: string;
  /** The member's display name. */
  name: string;
  /** The invited address, only for the owner or the member's inviter. */
  invitedEmail: string | null;
  bits: readonly string[];
  /** Owner-set; false (default) means no sealed-value capability. */
  includeSealedValues: boolean;
  createdAt: string;
};

const BITS: readonly Capability[] = ["read", "propose", "write", "review", "manage"];

export { describeControlError };

/**
 * `manage` shows invite/revoke; ownership transfer and the per-share
 * "include sealed values" option are owner-only, so a manager who is
 * not the owner never sees them. The server enforces all three.
 */
export function memberControls(
  bits: readonly string[],
  isOwner = false,
): { canManage: boolean; canTransfer: boolean; canSetSealed: boolean } {
  const canManage = bits.includes("manage");
  return { canManage, canTransfer: canManage && isOwner, canSetSealed: canManage && isOwner };
}

export const inviteAcceptHref = (lang: string, kbId: string, requestId: string) =>
  `/${encodeURIComponent(lang)}/kbs/${encodeURIComponent(kbId)}/settings?accept=${encodeURIComponent(requestId)}`;
export const transferAcceptHref = (lang: string, kbId: string, requestId: string) =>
  `/${encodeURIComponent(lang)}/kbs/${encodeURIComponent(kbId)}/settings?transfer=${encodeURIComponent(requestId)}`;

/** A link someone else can open: the app path on this page's origin. */
export function shareableUrl(path: string, origin = globalThis.location?.origin): string {
  return origin ? new URL(path, origin).href : path;
}

/**
 * Membership changed under this page (an invitation or transfer accepted):
 * drop every cached query holding this KB's private data (content and control
 * lists alike) and re-read `kbs.get` in place, so the header role and the
 * settings tabs mounted on it re-derive what is visible now (R2-11).
 */
export function refreshAfterAcceptance(queryClient: QueryClient, kbId: string): Promise<unknown> {
  clearKbPrivateQueries(queryClient, kbId, { keepAccessCheck: true });
  return Promise.all([
    // The new member can open the KB now: re-ask instead of keeping the
    // pre-acceptance "no access" answer.
    queryClient.invalidateQueries({ queryKey: orpc.kbs.get.key({ input: { kbId } }) }),
    queryClient.invalidateQueries({ queryKey: orpc.kbs.list.key() }),
  ]);
}

/**
 * A member's bits changed. The edited member can be the caller (a manager who
 * drops their own `manage`), so the KB's live bits are re-read along with the
 * member list: `kbs.get` re-derives this page's controls and `kbs.list` the
 * KB cards. The server enforces the change either way.
 */
export function refreshAfterMemberEdit(queryClient: QueryClient, kbId: string): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: orpc.kbs.shareList.key() }),
    queryClient.invalidateQueries({ queryKey: orpc.kbs.get.key({ input: { kbId } }) }),
    queryClient.invalidateQueries({ queryKey: orpc.kbs.list.key() }),
  ]);
}

/**
 * The server answers every invitation with `{accepted:true, requestId}`,
 * known address or not; this view renders only that, so it cannot differ.
 */
export function InviteResult({ href }: { href: string }) {
  const { t } = useTranslation("kb");
  return (
    <div data-testid="invite-result" data-href={href} role="status" className="space-y-2 text-sm">
      <p>{t("settings.members.inviteResult")}</p>
      <p className="text-xs text-muted-foreground">{t("settings.members.inviteLink")}</p>
      <CopyField value={href} copyLabel={t("settings.members.copyLink")} />
    </div>
  );
}

/** A member as people know them: their display name, else (no name set) their id. */
export function memberLabel(
  member: Pick<MemberRow, "name" | "userId">,
  t: (key: string, options: { id: string }) => string,
): string {
  // `?.` keeps a row readable if an older server omits the name.
  return member.name?.trim() || t("settings.members.memberId", { id: member.userId });
}

export function MemberRowsView({
  members,
  canManage,
  canTransfer = false,
  canSetSealed = false,
  sealedPending = false,
  sealedRequest,
  onEdit,
  onRevoke,
  onTransfer,
  onSetSealed,
  selfUserId,
}: {
  members: readonly MemberRow[];
  /** The signed-in user: their own row is marked "(you)". */
  selfUserId?: string | null;
  canManage: boolean;
  canTransfer?: boolean;
  canSetSealed?: boolean;
  sealedPending?: boolean;
  /**
   * The in-flight flag change. Its row shows the requested value (disabled)
   * until the server answers; a refusal falls back to the listed value.
   */
  sealedRequest?: { userId: string; includeSealedValues: boolean };
  onEdit?: (member: MemberRow) => void;
  onRevoke: (member: MemberRow) => void;
  onTransfer: (member: MemberRow) => void;
  onSetSealed?: (member: MemberRow, includeSealedValues: boolean) => void;
}) {
  const { t } = useTranslation("kb");
  if (members.length === 0)
    return <p className="text-sm text-muted-foreground">{t("settings.members.empty")}</p>;
  return (
    <ul className="divide-y rounded-md border">
      {members.map((member) => (
        <li
          key={member.shareId}
          data-testid="member-row"
          data-user-id={member.userId}
          className="flex min-w-0 flex-wrap items-center gap-2 p-3"
        >
          <span className="min-w-0 flex-1 basis-full space-y-0.5 sm:basis-0">
            <span data-testid="member-name" className="block truncate text-sm font-medium">
              {memberLabel(member, t)}
              {member.userId === selfUserId && (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  {t("settings.members.you")}
                </span>
              )}
            </span>
            {member.invitedEmail && (
              <span className="block truncate text-xs text-muted-foreground">
                {t("settings.members.invitedAs", { email: member.invitedEmail })}
              </span>
            )}
            <span className="block text-xs text-muted-foreground">
              {member.bits.map((bit) => t(`settings.bits.${bit}`)).join(", ")}
            </span>
          </span>
          {canSetSealed && (
            <label className="flex min-h-[44px] items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="member-sealed-toggle"
                className="size-4"
                checked={
                  sealedPending && sealedRequest?.userId === member.userId
                    ? sealedRequest.includeSealedValues
                    : member.includeSealedValues
                }
                disabled={sealedPending}
                aria-label={t("settings.members.includeSealedValuesFor", {
                  name: memberLabel(member, t),
                })}
                aria-busy={sealedPending && sealedRequest?.userId === member.userId}
                onChange={(event) => onSetSealed?.(member, event.target.checked)}
              />
              {t("settings.members.includeSealedValues")}
            </label>
          )}
          {canManage && (
            <span className="flex flex-wrap gap-2">
              {onEdit && (
                <Button
                  data-testid="member-edit"
                  variant="outline"
                  className="min-h-[44px]"
                  aria-label={t("settings.members.editFor", { name: memberLabel(member, t) })}
                  onClick={() => onEdit(member)}
                >
                  {t("settings.members.edit")}
                </Button>
              )}
              {canTransfer && (
                <Button
                  data-testid="member-transfer"
                  variant="outline"
                  className="min-h-[44px]"
                  aria-label={t("settings.members.transferTo", { name: memberLabel(member, t) })}
                  onClick={() => onTransfer(member)}
                >
                  {t("settings.members.transfer")}
                </Button>
              )}
              <Button
                data-testid="member-revoke"
                variant="outline"
                className="min-h-[44px]"
                aria-label={t("settings.members.revokeFor", { name: memberLabel(member, t) })}
                onClick={() => onRevoke(member)}
              >
                {t("settings.members.revoke")}
              </Button>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

function InviteForm({
  lang,
  kbId,
  onDenied,
}: {
  lang: string;
  kbId: string;
  onDenied: () => void;
}) {
  const { t, i18n } = useTranslation("kb");
  const session = useKbMutationSession();
  const attempt = useRenewableAttemptKey();
  const [bits, setBits] = useState<Capability[]>([]);
  const invite = useMutation(
    orpc.kbs.shareInvite.mutationOptions({
      onSuccess: () => {
        if (session.current) attempt.renew();
      },
      onError: (error) => {
        if (!session.current) return;
        if (describeControlError(error) === "denied") onDenied();
      },
    }),
  );
  const form = useForm({
    defaultValues: { email: "" },
    validators: { onSubmit: z.object({ email: z.string().trim().email() }) },
    onSubmit: ({ value }) => {
      if (bits.length === 0) return;
      invite.mutate({
        kbId,
        email: value.email.trim(),
        permissions: bits,
        idempotencyKey: attempt.key,
        // The invitation email is written in the inviter's language.
        locale: i18n.language === "es-MX" ? "es-MX" : "en-US",
      });
    },
  });
  const reset = () => {
    invite.reset();
    form.reset();
    setBits([]);
  };
  if (invite.data)
    return (
      <div className="space-y-3">
        <InviteResult href={shareableUrl(inviteAcceptHref(lang, kbId, invite.data.requestId))} />
        <Button
          data-testid="invite-another"
          variant="outline"
          className="min-h-[44px]"
          onClick={reset}
        >
          {t("settings.members.inviteAnother")}
        </Button>
      </div>
    );
  return (
    <form
      className="min-w-0 space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      <form.Field name="email">
        {(field) => (
          <TextField
            field={field}
            type="email"
            label={t("settings.members.email")}
            autoComplete="off"
            maxLength={320}
          />
        )}
      </form.Field>
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">{t("settings.members.permissions")}</legend>
        <div className="flex flex-wrap gap-3">
          {BITS.map((bit) => (
            <label key={bit} className="flex min-h-[44px] items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={bits.includes(bit)}
                onChange={(event) =>
                  setBits((prev) =>
                    event.target.checked ? [...prev, bit] : prev.filter((b) => b !== bit),
                  )
                }
              />
              {t(`settings.bits.${bit}`)}
            </label>
          ))}
        </div>
        {form.state.submissionAttempts > 0 && bits.length === 0 && (
          <p className="text-sm text-destructive">{t("settings.members.permissionsRequired")}</p>
        )}
      </fieldset>
      <ControlError error={invite.error} />
      <Button
        type="submit"
        data-testid="invite-submit"
        className="min-h-[44px]"
        disabled={invite.isPending}
      >
        {invite.isPending ? t("settings.members.inviting") : t("settings.members.invite")}
      </Button>
    </form>
  );
}

/**
 * Edit → Sheet: change a member's permission bits in place. The
 * server re-checks `manage` and expands implied bits; this only drafts them.
 */
function MemberBitsSheet({
  kbId,
  member,
  isSelf,
  onClose,
  onDenied,
}: {
  kbId: string;
  member: MemberRow;
  /** Editing your own row: dropping Manage asks first (R2-22). */
  isSelf: boolean;
  onClose: () => void;
  onDenied: () => void;
}) {
  const { t } = useTranslation("kb");
  const queryClient = useQueryClient();
  const session = useKbMutationSession();
  const [bits, setBits] = useState<Capability[]>(() =>
    BITS.filter((bit) => member.bits.includes(bit)),
  );
  const update = useMutation(
    orpc.kbs.shareUpdate.mutationOptions({
      onSuccess: async () => {
        await refreshAfterMemberEdit(queryClient, kbId);
        if (session.current) onClose();
      },
      onError: (error) => {
        if (session.current && describeControlError(error) === "denied") onDenied();
      },
    }),
  );
  const name = memberLabel(member, t);
  const [confirmSelfDemotion, setConfirmSelfDemotion] = useState(false);
  const send = () => update.mutate({ kbId, shareUserId: member.userId, permissions: bits });
  return (
    <Sheet open onOpenChange={(open) => !open && !update.isPending && onClose()}>
      <ConfirmActionDialog
        open={confirmSelfDemotion}
        onOpenChange={setConfirmSelfDemotion}
        title={t("settings.members.selfDemoteTitle")}
        description={t("settings.members.selfDemoteDescription")}
        confirmLabel={t("settings.members.selfDemoteConfirm")}
        destructive
        onConfirm={() => {
          setConfirmSelfDemotion(false);
          send();
        }}
      />
      <SheetContent data-testid="member-edit-sheet" className="overflow-y-auto overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>{t("settings.members.editTitle", { name })}</SheetTitle>
          <SheetDescription>{t("settings.members.editDescription")}</SheetDescription>
        </SheetHeader>
        <form
          className="min-w-0 space-y-4 px-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (bits.length === 0 || update.isPending) return;
            if (isSelf && member.bits.includes("manage") && !bits.includes("manage")) {
              setConfirmSelfDemotion(true);
              return;
            }
            send();
          }}
        >
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">{t("settings.members.permissions")}</legend>
            <div className="flex flex-col">
              {BITS.map((bit) => (
                <label key={bit} className="flex min-h-[44px] items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={bits.includes(bit)}
                    disabled={update.isPending}
                    onChange={(event) =>
                      setBits((prev) =>
                        event.target.checked ? [...prev, bit] : prev.filter((b) => b !== bit),
                      )
                    }
                  />
                  {t(`settings.bits.${bit}`)}
                </label>
              ))}
            </div>
            {bits.length === 0 && (
              <p className="text-sm text-destructive">
                {t("settings.members.permissionsRequired")}
              </p>
            )}
          </fieldset>
          <ControlError error={update.error} />
          <SheetFooter className="px-0">
            <Button
              type="submit"
              data-testid="member-edit-save"
              className="min-h-[44px]"
              disabled={update.isPending || bits.length === 0}
            >
              {update.isPending ? t("settings.members.pending") : t("settings.members.editSave")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

type PendingAction = { kind: "revoke" | "transfer"; member: MemberRow } | null;

/** Invite (neutral), accepted-member list, revoke and owner transfer request. */
function MembersPanel({
  kb,
  lang,
  onDenied,
}: {
  kb: SettingsKb;
  lang: string;
  onDenied: () => void;
}) {
  const { t } = useTranslation("kb");
  const queryClient = useQueryClient();
  const { canManage, canTransfer, canSetSealed } = memberControls(kb.capabilities, kb.isOwner);
  const authSession = useAuthSession();
  const selfUserId =
    authSession.state.status === "authenticated" ? authSession.state.session.user.id : null;
  const session = useKbMutationSession();
  const [pending, setPending] = useState<PendingAction>(null);
  const [editing, setEditing] = useState<MemberRow | null>(null);
  const [transferHref, setTransferHref] = useState<string | null>(null);
  const transferKey = useRenewableAttemptKey();
  const members = useInfiniteQuery(
    orpc.kbs.shareList.infiniteOptions({
      input: (cursor: string | null) => ({ kbId: kb.id, limit: 20, cursor }),
      initialPageParam: null,
      getNextPageParam: (last) => last?.nextCursor ?? null,
      enabled: canManage,
      retry: false,
    }),
  );
  const denied = (error: unknown) => {
    if (!session.current) return;
    // The confirmation closes; the refusal is shown below the list.
    setPending(null);
    if (describeControlError(error) === "denied") onDenied();
  };
  const revoke = useMutation(
    orpc.kbs.shareRevoke.mutationOptions({
      onSuccess: async () => {
        if (session.current) setPending(null);
        await queryClient.invalidateQueries({ queryKey: orpc.kbs.shareList.key() });
      },
      onError: denied,
    }),
  );
  const [sealedRequest, setSealedRequest] = useState<{
    userId: string;
    includeSealedValues: boolean;
  }>();
  const setSealed = useMutation(
    orpc.kbs.shareSetSealedValues.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: orpc.kbs.shareList.key() });
      },
      onError: denied,
    }),
  );
  const transfer = useMutation(
    orpc.kbs.transferRequest.mutationOptions({
      onSuccess: (result) => {
        if (!session.current) return;
        setPending(null);
        transferKey.renew();
        setTransferHref(shareableUrl(transferAcceptHref(lang, kb.id, result.requestId)));
      },
      onError: denied,
    }),
  );
  if (isQueryAccessError(members.error))
    return (
      <InlineRetry message={t("settings.members.listFailed")} onRetry={() => members.refetch()} />
    );
  if (!canManage) return null;
  const rows = members.data?.pages.flatMap((page) => page?.items ?? []) ?? [];
  const member = pending?.member;
  return (
    <section
      data-testid="members-panel"
      aria-labelledby="kb-members-title"
      className="min-w-0 space-y-4"
    >
      <header className="space-y-1">
        <h2 id="kb-members-title" className="text-lg font-semibold">
          {t("settings.members.title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("settings.members.description")}</p>
      </header>
      <InviteForm lang={lang} kbId={kb.id} onDenied={onDenied} />
      <QueryBoundary
        query={members}
        errorMessage={t("settings.members.listFailed")}
        skeleton={
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        }
      >
        {() => (
          <MemberRowsView
            members={rows}
            selfUserId={selfUserId}
            canManage={canManage}
            canTransfer={canTransfer}
            canSetSealed={canSetSealed}
            sealedPending={setSealed.isPending || sealedRequest !== undefined}
            sealedRequest={sealedRequest}
            onEdit={setEditing}
            onRevoke={(row) => setPending({ kind: "revoke", member: row })}
            onTransfer={(row) => setPending({ kind: "transfer", member: row })}
            onSetSealed={(row, includeSealedValues) => {
              // Set in the click's own render so the controlled box never snaps
              // back before the mutation reports pending.
              setSealedRequest({ userId: row.userId, includeSealedValues });
              setSealed.mutate(
                { kbId: kb.id, shareUserId: row.userId, includeSealedValues },
                { onSettled: () => setSealedRequest(undefined) },
              );
            }}
          />
        )}
      </QueryBoundary>
      <LoadMore
        hasNextPage={members.hasNextPage}
        isFetchingNextPage={members.isFetchingNextPage}
        onLoadMore={() => members.fetchNextPage()}
      />
      {canSetSealed && rows.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("settings.members.includeSealedValuesHint")}
        </p>
      )}
      <ControlError error={revoke.error ?? transfer.error ?? setSealed.error} />
      {editing && (
        <MemberBitsSheet
          key={editing.shareId}
          kbId={kb.id}
          member={editing}
          isSelf={editing.userId === selfUserId}
          onClose={() => setEditing(null)}
          onDenied={onDenied}
        />
      )}
      {transferHref && (
        <div
          data-testid="transfer-requested"
          data-href={transferHref}
          role="status"
          className="space-y-2 text-sm"
        >
          <p>{t("settings.members.transferRequested")}</p>
          <CopyField value={transferHref} copyLabel={t("settings.members.copyLink")} />
        </div>
      )}
      <ConfirmDeleteDialog
        open={pending?.kind === "revoke"}
        onOpenChange={(open) => !open && setPending(null)}
        title={t("settings.members.revokeTitle")}
        description={t("settings.members.revokeDescription", {
          name: member ? memberLabel(member, t) : "",
        })}
        confirmToken="REVOKE"
        typePrompt={t("settings.members.revokePrompt")}
        copyAriaLabel={t("settings.members.copyToken")}
        inputMode="text"
        confirmLabel={t("settings.members.revokeAction")}
        pendingLabel={t("settings.members.pending")}
        isPending={revoke.isPending}
        onConfirm={() => member && revoke.mutate({ kbId: kb.id, shareUserId: member.userId })}
      />
      <ConfirmDeleteDialog
        open={pending?.kind === "transfer"}
        onOpenChange={(open) => !open && setPending(null)}
        title={t("settings.members.transferTitle")}
        description={t("settings.members.transferDescription", {
          name: member ? memberLabel(member, t) : "",
          version: kb.metadataVersion,
        })}
        confirmToken="TRANSFER"
        typePrompt={t("settings.members.transferPrompt")}
        copyAriaLabel={t("settings.members.copyToken")}
        inputMode="text"
        confirmLabel={t("settings.members.transferAction")}
        pendingLabel={t("settings.members.pending")}
        isPending={transfer.isPending}
        onConfirm={() =>
          member &&
          transfer.mutate({
            kbId: kb.id,
            recipientUserId: member.userId,
            // Pinned: any metadata change before acceptance voids the request.
            metadataVersion: kb.metadataVersion,
            idempotencyKey: transferKey.key,
          })
        }
      />
    </section>
  );
}

/**
 * R2-21: accepting a pending request that no longer exists (already accepted,
 * revoked, or replaced by a newer invitation) answers NOT_FOUND. That is not a
 * permissions problem, so the card says the link was used or replaced.
 */
export function isAcceptRequestGone(error: unknown): boolean {
  return controlErrorCode(error) === "NOT_FOUND";
}

function AcceptCard({
  kind,
  requestId,
  onAccepted,
}: {
  kind: "share" | "transfer";
  requestId: string;
  onAccepted: () => void;
}) {
  const { t } = useTranslation("kb");
  const session = useKbMutationSession();
  const accepted = () => {
    if (session.current) onAccepted();
  };
  const share = useMutation(orpc.kbs.shareAccept.mutationOptions({ onSuccess: accepted }));
  const transfer = useMutation(orpc.kbs.transferAccept.mutationOptions({ onSuccess: accepted }));
  const mutation = kind === "share" ? share : transfer;
  return (
    <section
      data-testid={`${kind}-accept`}
      aria-labelledby={`${kind}-accept-title`}
      className="min-w-0 space-y-3 rounded-md border p-4"
    >
      <h2 id={`${kind}-accept-title`} className="font-semibold">
        {t(`settings.accept.${kind}Title`)}
      </h2>
      <p className="text-sm text-muted-foreground">{t(`settings.accept.${kind}Description`)}</p>
      {mutation.isSuccess ? (
        <p data-testid={`${kind}-accept-done`} role="status" className="text-sm font-medium">
          {t(`settings.accept.${kind}Done`)}
        </p>
      ) : isAcceptRequestGone(mutation.error) ? (
        <p role="alert" data-testid={`${kind}-accept-gone`} className="text-sm text-destructive">
          {t(`settings.accept.${kind}Gone`)}
        </p>
      ) : (
        <>
          <ControlError error={mutation.error} />
          <Button
            data-testid={`${kind}-accept-submit`}
            className="min-h-[44px]"
            disabled={mutation.isPending}
            onClick={() =>
              kind === "share" ? share.mutate({ requestId }) : transfer.mutate({ requestId })
            }
          >
            {mutation.isPending
              ? t("settings.accept.accepting")
              : t(`settings.accept.${kind}Action`)}
          </Button>
        </>
      )}
    </section>
  );
}

export const KB_SETTINGS_TABS = ["members", "search", "sealed", "mirror"] as const;
export type KbSettingsTab = (typeof KB_SETTINGS_TABS)[number];

/**
 * The settings tabs this caller can use, from the live bits: Members and
 * Mirror need `manage`, Sealed values is owner-only, Search & index
 * is shown to every reader (controls inside still need `manage`).
 */
export function kbSettingsTabs(kb: { capabilities: readonly string[]; isOwner: boolean }) {
  const tabs: KbSettingsTab[] = [];
  if (memberControls(kb.capabilities, kb.isOwner).canManage) tabs.push("members");
  tabs.push("search");
  if (sealedControls(kb.capabilities, kb.isOwner).visible) tabs.push("sealed");
  if (mirrorControls(kb.capabilities).visible) tabs.push("mirror");
  return tabs;
}

/** One card per concern, like the account settings pages. */
const SETTINGS_CARD =
  "min-w-0 rounded-xl bg-card p-4 text-card-foreground ring-1 ring-foreground/10 sm:p-6";

/** Members · Search & index · Sealed values · Mirror, as ARIA tabs over one panel. */
function SettingsTabBar({
  tabs,
  active,
  idPrefix,
  onSelect,
}: {
  tabs: readonly KbSettingsTab[];
  active: KbSettingsTab;
  idPrefix: string;
  onSelect: (tab: KbSettingsTab) => void;
}) {
  const { t } = useTranslation("kb");
  const focusTab = (index: number) => {
    const next = tabs[(index + tabs.length) % tabs.length];
    if (!next) return;
    onSelect(next);
    document.getElementById(`${idPrefix}-tab-${next}`)?.focus();
  };
  return (
    <WideContent>
      <div
        role="tablist"
        aria-label={t("settings.tabs.label")}
        className="flex w-max gap-1 rounded-none bg-muted/60 p-1"
        onKeyDown={(event) => {
          const index = tabs.indexOf(active);
          if (event.key === "ArrowRight") focusTab(index + 1);
          else if (event.key === "ArrowLeft") focusTab(index - 1);
          else if (event.key === "Home") focusTab(0);
          else if (event.key === "End") focusTab(tabs.length - 1);
          else return;
          event.preventDefault();
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab}`}
            data-testid={`kb-settings-tab-${tab}`}
            aria-selected={tab === active}
            aria-controls={`${idPrefix}-panel-${tab}`}
            tabIndex={tab === active ? 0 : -1}
            className={cn(
              buttonVariants({ variant: "ghost", size: "touch" }),
              "shrink-0 text-muted-foreground hover:bg-background/60",
              tab === active && "bg-background text-foreground shadow-xs hover:bg-background",
            )}
            onClick={() => onSelect(tab)}
          >
            {t(`settings.tabs.${tab}`)}
          </button>
        ))}
      </div>
    </WideContent>
  );
}

/**
 * The KB settings page body (route and browser harness share it): recipient
 * acceptance cards, then member, embedding-profile and sealed controls, each
 * shown only when the live bits allow it and still handling server denial.
 */
export function KbSettingsView({
  lang,
  kbId,
  accept,
  transfer,
  tab,
  onTabChange,
}: {
  lang: string;
  kbId: string;
  accept?: string;
  transfer?: string;
  /** The requested tab (the route keeps it in the URL); falls back to the first usable one. */
  tab?: KbSettingsTab;
  onTabChange?: (tab: KbSettingsTab) => void;
}) {
  const { t } = useTranslation("kb");
  const idPrefix = useId();
  // Uncontrolled (no onTabChange): the clicked tab, else the requested one.
  const [localTab, setLocalTab] = useState<KbSettingsTab>();
  const requested = onTabChange ? tab : (localTab ?? tab);
  const selectTab = (next: KbSettingsTab) => (onTabChange ? onTabChange(next) : setLocalTab(next));
  const queryClient = useQueryClient();
  const { data, error, isPending, isError, refetch } = useQuery(
    orpc.kbs.get.queryOptions({ input: { kbId }, retry: false }),
  );
  const lost = useKbAccessLoss(kbId, [error]);
  const onDenied = () => {
    // A denied control action is not proof of lost access (a manager is
    // refused owner-only actions). Re-check the KB permission: the refetched
    // bits and isOwner re-derive the controls, and the KB's cached data is
    // cleared only if that check says read access is gone.
    void recheckKbAccess(queryClient, kbId);
  };
  const onAccepted = () => {
    void refreshAfterAcceptance(queryClient, kbId);
  };
  const cards = (
    <>
      {accept && (
        <AcceptCard
          key={`share:${kbId}:${accept}`}
          kind="share"
          requestId={accept}
          onAccepted={onAccepted}
        />
      )}
      {transfer && (
        <AcceptCard
          key={`transfer:${kbId}:${transfer}`}
          kind="transfer"
          requestId={transfer}
          onAccepted={onAccepted}
        />
      )}
    </>
  );
  let body: React.ReactNode;
  // An invitee has no access before accepting; the card is the whole page then.
  if (lost && (accept || transfer)) body = null;
  else if (lost)
    body = (
      <p
        data-testid="kb-settings-unavailable"
        role="alert"
        className="rounded-md border p-4 text-sm"
      >
        {t("settings.unavailable")}
      </p>
    );
  else if (isPending)
    body = (
      <div className="space-y-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  else if (isError || !data)
    body = <InlineRetry message={t("settings.loadFailed")} onRetry={() => refetch()} />;
  else {
    const tabs = kbSettingsTabs(data.kb);
    const active = requested && tabs.includes(requested) ? requested : (tabs[0] ?? "search");
    body = (
      <div className="min-w-0 space-y-6">
        {tabs.length > 1 && (
          <SettingsTabBar tabs={tabs} active={active} idPrefix={idPrefix} onSelect={selectTab} />
        )}
        {/* Every usable tab stays mounted (hidden when inactive) so a draft in
            one tab survives switching to another; drafts still retire with
            the KB identity (the keys below). */}
        {tabs.map((tab) => (
          <div
            key={tab}
            id={`${idPrefix}-panel-${tab}`}
            role={tabs.length > 1 ? "tabpanel" : undefined}
            aria-labelledby={tabs.length > 1 ? `${idPrefix}-tab-${tab}` : undefined}
            data-testid={`kb-settings-panel-${tab}`}
            hidden={tab !== active}
            className="min-w-0 space-y-6"
          >
            {tab === "members" && (
              <div className={SETTINGS_CARD}>
                <MembersPanel
                  key={`members:${kbId}`}
                  kb={data.kb}
                  lang={lang}
                  onDenied={onDenied}
                />
              </div>
            )}
            {tab === "search" && (
              <>
                <div className={SETTINGS_CARD}>
                  <ProfilePanel key={`profile:${kbId}`} kb={data.kb} onDenied={onDenied} />
                </div>
                <div className={SETTINGS_CARD}>
                  <IndexSettingsPanel key={`index:${kbId}`} kb={data.kb} onDenied={onDenied} />
                </div>
              </>
            )}
            {tab === "sealed" && (
              <div className={SETTINGS_CARD}>
                <SealedPanel key={`sealed:${kbId}`} kb={data.kb} onDenied={onDenied} />
              </div>
            )}
            {tab === "mirror" && (
              <div className={SETTINGS_CARD}>
                <MirrorPanel key={`mirror:${kbId}`} kb={data.kb} />
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div data-testid="kb-settings" className="min-w-0 space-y-6">
      {cards}
      {body}
    </div>
  );
}
