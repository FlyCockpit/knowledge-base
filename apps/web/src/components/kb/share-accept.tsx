import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { Button } from "@knowledge-base/ui/components/button";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { InlineRetry } from "@/components/inline-retry";
import { PermissionSummary } from "@/components/kb/permission-descriptions";
import { ControlError, controlErrorCode } from "@/components/kb/profile-panel";
import { useKbMutationSession } from "@/hooks/use-kb-mutation-session";
import { useViewerId, VIEWER_SCOPED_CACHE, viewerScopedKey } from "@/hooks/use-viewer-scope";
import { isQueryAccessError } from "@/lib/query-access-error";
import { orpc } from "@/utils/orpc";

export type ShareInvitePreview = Awaited<ReturnType<AppRouterClient["kbs"]["shareInvitePreview"]>>;

type PreviewState =
  | { status: "pending" }
  | { status: "ready"; preview: ShareInvitePreview }
  /** Missing, used, cancelled, replaced or addressed to someone else: one answer. */
  | { status: "gone" }
  | { status: "failed"; retry: () => void };

type AcceptState = { isPending: boolean; isSuccess: boolean; error: unknown };

/**
 * What the recipient of a share invitation sees before accepting: who invited
 * them to which KB, and the permissions in words. Every "not yours / no
 * longer valid" case looks the same (the server answers one NOT_FOUND).
 */
export function ShareInvitationView({
  lang,
  preview,
  accept,
  onAccept,
}: {
  lang: string;
  preview: PreviewState;
  accept: AcceptState;
  onAccept: () => void;
}) {
  const { t } = useTranslation("kb");
  const gone = preview.status === "gone" || controlErrorCode(accept.error) === "NOT_FOUND";
  let body: React.ReactNode;
  if (preview.status === "pending")
    body = (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-6 w-64" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-11 w-44" />
      </div>
    );
  else if (gone)
    body = (
      <>
        <h2 id="share-accept-title" className="font-semibold">
          {t("settings.accept.shareTitle")}
        </h2>
        <div role="alert" data-testid="share-accept-gone" className="space-y-1 text-sm">
          <p className="text-destructive">{t("settings.accept.shareGone")}</p>
          <p className="text-muted-foreground">{t("settings.accept.shareGoneHint")}</p>
        </div>
        <Link
          to="/$lang/kbs"
          params={{ lang }}
          className="inline-flex min-h-11 items-center text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {t("settings.accept.openKbs")}
        </Link>
      </>
    );
  else if (preview.status === "failed")
    body = <InlineRetry message={t("settings.accept.previewFailed")} onRetry={preview.retry} />;
  else
    body = (
      <>
        <h2 id="share-accept-title" className="font-semibold">
          {t("settings.accept.shareHeading", {
            inviter: preview.preview.inviterName,
            kb: preview.preview.kbName,
          })}
        </h2>
        <p className="text-sm text-muted-foreground">{t("settings.accept.shareDescription")}</p>
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("settings.accept.sharePermissions")}</p>
          <PermissionSummary bits={preview.preview.bits} />
        </div>
        {accept.isSuccess ? (
          <p data-testid="share-accept-done" role="status" className="text-sm font-medium">
            {t("settings.accept.shareDone")}
          </p>
        ) : (
          <>
            <ControlError error={accept.error} />
            <Button
              data-testid="share-accept-submit"
              className="min-h-[44px]"
              disabled={accept.isPending}
              onClick={onAccept}
            >
              {accept.isPending ? t("settings.accept.accepting") : t("settings.accept.shareAction")}
            </Button>
          </>
        )}
      </>
    );
  return (
    <section
      data-testid="share-accept"
      aria-labelledby="share-accept-title"
      className="min-w-0 space-y-3 rounded-md border p-4"
    >
      {body}
    </section>
  );
}

/**
 * The card's state from the preview query. An access denial wins over cached
 * data: once a refetch says the invitation is gone (cancelled, used, or the
 * account changed) or the session no longer admits the caller, its names and
 * permissions are no longer shown. A transient failure keeps what was loaded.
 */
export function sharePreviewState(
  query: { data: ShareInvitePreview | undefined; error: unknown; isPending: boolean },
  retry: () => void,
): PreviewState {
  // Any access denial (gone, a signed-out or banned session, 2FA now
  // required) hides what was loaded; only a transient failure keeps it.
  if (isQueryAccessError(query.error)) return { status: "gone" };
  if (query.data) return { status: "ready", preview: query.data };
  if (query.isPending) return { status: "pending" };
  return { status: "failed", retry };
}

/**
 * The share-invitation card on KB settings (`?accept=`). It reads only the
 * invitation preview, never the KB itself (the recipient has no access yet).
 */
export function ShareAcceptCard({
  lang,
  requestId,
  onAccepted,
}: {
  lang: string;
  requestId: string;
  /** Called with the accepted KB's id; the page moves on to its documents. */
  onAccepted: (kbId: string) => void;
}) {
  const session = useKbMutationSession();
  const viewerId = useViewerId();
  const { data, error, isPending, refetch } = useQuery(
    orpc.kbs.shareInvitePreview.queryOptions({
      input: { requestId },
      // Only the invited account may see it: scoped to the viewer.
      queryKey: viewerScopedKey(
        orpc.kbs.shareInvitePreview.queryKey({ input: { requestId } }),
        viewerId,
      ),
      enabled: viewerId !== null,
      retry: false,
      // Every failure renders in the card (gone, or Try again): no toast too.
      meta: { skipGlobalErrorToast: true },
      ...VIEWER_SCOPED_CACHE,
    }),
  );
  const accept = useMutation(
    orpc.kbs.shareAccept.mutationOptions({
      // A refusal shows in the card (gone, or the inline error).
      meta: { skipGlobalErrorToast: true },
      onSuccess: () => {
        if (session.current && data) onAccepted(data.kbId);
      },
    }),
  );
  const state = sharePreviewState({ data, error, isPending }, () => void refetch());
  return (
    <ShareInvitationView
      lang={lang}
      preview={state}
      accept={{ isPending: accept.isPending, isSuccess: accept.isSuccess, error: accept.error }}
      onAccept={() => accept.mutate({ requestId })}
    />
  );
}
