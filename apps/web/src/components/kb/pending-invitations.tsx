import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { Button } from "@knowledge-base/ui/components/button";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import {
  ControlError,
  controlErrorCode,
  describeControlError,
} from "@/components/kb/profile-panel";
import { LoadMore } from "@/components/load-more";
import { QueryBoundary } from "@/components/query-boundary";
import { useKbMutationSession } from "@/hooks/use-kb-mutation-session";
import { useRenewableAttemptKey } from "@/hooks/use-renewable-attempt-key";
import { orpc } from "@/utils/orpc";

export type PendingInvitation = Awaited<
  ReturnType<AppRouterClient["kbs"]["sharePendingList"]>
>["items"][number];

type Translate = (key: string, options: Record<string, string>) => string;

/** The address when this viewer may see it, else who sent the invitation. */
export function pendingInvitationLabel(invitation: PendingInvitation, t: Translate): string {
  return (
    invitation.email ??
    t("settings.members.pendingInvites.sentBy", { name: invitation.inviterName })
  );
}

/**
 * When it was sent and, if the address is shown, by whom (a hidden address
 * is already labelled with its sender).
 */
function pendingInvitationSentLine(
  invitation: PendingInvitation,
  date: string,
  t: Translate,
): string {
  if (!invitation.email) return t("settings.members.pendingInvites.sentOn", { date });
  return invitation.invitedByYou
    ? t("settings.members.pendingInvites.sentOnByYou", { date })
    : t("settings.members.pendingInvites.sentOnBy", { date, name: invitation.inviterName });
}

type ResendState = {
  invitationId: string;
  status: "pending" | "sent" | "failed";
  error?: unknown;
};

export function PendingInvitationRowsView({
  invitations,
  acceptHref,
  resend,
  canResend = true,
  onResend,
  onCancel,
}: {
  invitations: readonly PendingInvitation[];
  /** The absolute acceptance link for a request id (owner and sender only get one). */
  acceptHref: (requestId: string) => string;
  /** The latest resend, shown on its row. */
  resend?: ResendState;
  /** False without SMTP: nothing would be sent, the copyable link is the delivery. */
  canResend?: boolean;
  onResend: (invitation: PendingInvitation) => void;
  onCancel: (invitation: PendingInvitation) => void;
}) {
  const { t, i18n } = useTranslation("kb");
  if (invitations.length === 0)
    return (
      <p className="text-sm text-muted-foreground">{t("settings.members.pendingInvites.empty")}</p>
    );
  const formatDate = (value: string) =>
    new Date(value).toLocaleDateString(i18n.language, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  return (
    <ul className="divide-y rounded-md border">
      {invitations.map((invitation) => {
        const label = pendingInvitationLabel(invitation, t);
        const rowResend = resend?.invitationId === invitation.invitationId ? resend : undefined;
        return (
          <li
            key={invitation.invitationId}
            data-testid="pending-invitation"
            data-invitation-id={invitation.invitationId}
            className="min-w-0 space-y-2 p-3"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 basis-full space-y-0.5 sm:basis-0">
                <span
                  data-testid="pending-invitation-label"
                  className="block truncate text-sm font-medium"
                >
                  {label}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {invitation.bits.map((bit) => t(`settings.bits.${bit}`)).join(", ")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {pendingInvitationSentLine(invitation, formatDate(invitation.sentAt), t)}
                </span>
              </span>
              <span className="flex flex-wrap gap-2">
                {canResend && (
                  <Button
                    data-testid="pending-invitation-resend"
                    variant="outline"
                    className="min-h-[44px]"
                    disabled={rowResend?.status === "pending"}
                    aria-label={t("settings.members.pendingInvites.resendFor", { label })}
                    onClick={() => onResend(invitation)}
                  >
                    {rowResend?.status === "pending"
                      ? t("settings.members.pendingInvites.resending")
                      : t("settings.members.pendingInvites.resend")}
                  </Button>
                )}
                <Button
                  data-testid="pending-invitation-cancel"
                  variant="outline"
                  className="min-h-[44px]"
                  aria-label={t("settings.members.pendingInvites.cancelFor", { label })}
                  onClick={() => onCancel(invitation)}
                >
                  {t("settings.members.pendingInvites.cancel")}
                </Button>
              </span>
            </div>
            {rowResend?.status === "sent" && (
              <p role="status" data-testid="pending-invitation-resent" className="text-sm">
                {t("settings.members.pendingInvites.resent")}
              </p>
            )}
            {rowResend?.status === "failed" &&
              (controlErrorCode(rowResend.error) === "CONFLICT" ? (
                <p
                  role="alert"
                  data-testid="pending-invitation-sender-gone"
                  className="text-sm text-destructive"
                >
                  {t("settings.members.pendingInvites.senderGone")}
                </p>
              ) : (
                <ControlError error={rowResend.error} />
              ))}
            {invitation.requestId && (
              <CopyField
                data-testid="pending-invitation-link"
                value={acceptHref(invitation.requestId)}
                copyLabel={t("settings.members.copyLink")}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Pending invitations under the invite form (`manage`): resend the email for
 * the same link, or cancel with a simple confirmation (a cancelled address can
 * be invited again, so nothing is typed).
 */
export function PendingInvitations({
  kbId,
  acceptHref,
  onDenied,
}: {
  kbId: string;
  acceptHref: (requestId: string) => string;
  onDenied: () => void;
}) {
  const { t, i18n } = useTranslation("kb");
  const queryClient = useQueryClient();
  const session = useKbMutationSession();
  const resendKey = useRenewableAttemptKey();
  const [cancelling, setCancelling] = useState<PendingInvitation | null>(null);
  const [resendState, setResendState] = useState<ResendState>();
  const { data: appConfig } = useQuery(orpc.appConfig.queryOptions());
  const pendingInput = (cursor: string | null) => ({ kbId, limit: 20, cursor });
  const pending = useInfiniteQuery(
    orpc.kbs.sharePendingList.infiniteOptions({
      input: pendingInput,
      initialPageParam: null,
      getNextPageParam: (last) => last?.nextCursor ?? null,
      // Others change it (an invitee accepts, a member leaves) while this
      // account stays signed in: read it anew on every visit.
      gcTime: 0,
      retry: false,
    }),
  );
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: orpc.kbs.sharePendingList.key() });
  const resend = useMutation(
    orpc.kbs.shareInviteResend.mutationOptions({
      onSuccess: (_result, variables) => {
        if (!session.current) return;
        resendKey.renew();
        setResendState({ invitationId: variables.invitationId, status: "sent" });
      },
      onError: (error, variables) => {
        if (!session.current) return;
        setResendState({ invitationId: variables.invitationId, status: "failed", error });
        if (describeControlError(error) === "denied") {
          void refresh();
          onDenied();
        }
      },
    }),
  );
  const cancel = useMutation(
    orpc.kbs.shareInviteCancel.mutationOptions({
      onSuccess: async () => {
        if (session.current) setCancelling(null);
        await refresh();
      },
      onError: (error) => {
        if (!session.current) return;
        setCancelling(null);
        if (describeControlError(error) === "denied") {
          void refresh();
          onDenied();
        }
      },
    }),
  );
  const rows = pending.data?.pages.flatMap((page) => page?.items ?? []) ?? [];
  return (
    <section
      data-testid="pending-invitations"
      aria-labelledby="kb-pending-invitations-title"
      className="min-w-0 space-y-3"
    >
      <header className="space-y-1">
        <h3 id="kb-pending-invitations-title" className="font-semibold">
          {t("settings.members.pendingInvites.title")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t("settings.members.pendingInvites.description")}
        </p>
      </header>
      <QueryBoundary
        query={pending}
        errorMessage={t("settings.members.pendingInvites.listFailed")}
        skeleton={<Skeleton className="h-16 w-full" />}
      >
        {() => (
          <PendingInvitationRowsView
            invitations={rows}
            acceptHref={acceptHref}
            resend={resendState}
            canResend={appConfig?.emailEnabled !== false}
            onResend={(invitation) => {
              setResendState({ invitationId: invitation.invitationId, status: "pending" });
              resend.mutate({
                kbId,
                invitationId: invitation.invitationId,
                sentAt: invitation.sentAt,
                idempotencyKey: resendKey.key,
                // The email is written in the sender's language, like an invite.
                locale: i18n.language === "es-MX" ? "es-MX" : "en-US",
              });
            }}
            onCancel={setCancelling}
          />
        )}
      </QueryBoundary>
      <LoadMore
        hasNextPage={pending.hasNextPage}
        isFetchingNextPage={pending.isFetchingNextPage}
        onLoadMore={() => pending.fetchNextPage()}
      />
      <ControlError error={cancel.error} testId="pending-invitation-cancel-error" />
      <ConfirmActionDialog
        open={cancelling !== null}
        onOpenChange={(open) => !open && !cancel.isPending && setCancelling(null)}
        title={t("settings.members.pendingInvites.cancelTitle")}
        description={t("settings.members.pendingInvites.cancelDescription")}
        confirmLabel={t("settings.members.pendingInvites.cancelAction")}
        cancelLabel={t("settings.members.pendingInvites.keep")}
        pendingLabel={t("settings.members.pending")}
        isPending={cancel.isPending}
        destructive
        onConfirm={() =>
          cancelling &&
          cancel.mutate({
            kbId,
            invitationId: cancelling.invitationId,
            sentAt: cancelling.sentAt,
          })
        }
      />
    </section>
  );
}
