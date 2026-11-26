import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
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
import { cn } from "@knowledge-base/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { actorLine } from "@/components/kb/document-history";
import { type DiffLine, lineDiff } from "@/components/kb/pr-diff";
import { restoreSourceInput, useDocumentRestore } from "@/hooks/use-document-restore";
import {
  confirmableConflict,
  type EditorOutcome,
  isPathNotFound,
  useKbAccessLoss,
} from "@/hooks/use-kb-editor";
import { isQueryAccessError } from "@/lib/query-access-error";

type Rebase = { headSha: string; proposalNumber: number | null };

import { orpc } from "@/utils/orpc";

/** Unchanged lines kept around each change in the restore preview. */
const CONTEXT_LINES = 2;

export type DiffRow = DiffLine | { kind: "gap"; count: number };

/**
 * The changed lines with a little context; each run of unchanged lines
 * beyond it collapses to one "n unchanged lines" row.
 */
export function compactDiff(lines: readonly DiffLine[], context = CONTEXT_LINES): DiffRow[] {
  const keep = lines.map(() => false);
  lines.forEach((line, index) => {
    if (line.kind === "same") return;
    for (
      let i = Math.max(0, index - context);
      i <= Math.min(lines.length - 1, index + context);
      i++
    )
      keep[i] = true;
  });
  const rows: DiffRow[] = [];
  let gap = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (gap > 0) rows.push({ kind: "gap", count: gap });
      gap = 0;
      rows.push(line);
    } else gap++;
  });
  if (gap > 0) rows.push({ kind: "gap", count: gap });
  return rows;
}

/**
 * Restore → Dialog: what restoring this version changes (a line diff from
 * the current version, or the whole text for a deleted document), then
 * one confirmation. The restore is a new revision; nothing is lost from
 * history. Writers who propose get a pull request instead.
 */
export function RestoreVersionDialog({
  lang,
  kbId,
  kbHeadSha,
  proposing,
  path,
  sourcePath,
  revision,
  open,
  onOpenChange,
  onRestored,
}: {
  lang: string;
  kbId: string;
  /** Main's head as the KB reports it: the base when main has no such document. */
  kbHeadSha: string;
  /** The viewer can only propose: restoring opens or extends a pull request. */
  proposing: boolean;
  path: string;
  /** Where the document lived at `revision`, when renamed since (read there, restored to `path`). */
  sourcePath?: string;
  revision: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Restored on main, or proposed (the toast was shown). */
  onRestored: (outcome: Extract<EditorOutcome, { kind: "applied" | "noop" | "proposed" }>) => void;
}) {
  const { t } = useTranslation("kb");
  const quiet = { meta: { skipGlobalErrorToast: true }, retry: false } as const;
  // After a conflict: the head the user is shown and confirms against
  // (main moved, or their own pull request already changes this document).
  const [against, setAgainst] = useState<Rebase | null>(null);
  const source = useQuery({
    ...orpc.documents.get.queryOptions({
      input: restoreSourceInput({ kbId, path, revision, sourcePath }),
    }),
    ...quiet,
    enabled: open,
  });
  // Main's version now (or none: the document was deleted), read fresh;
  // after a conflict, the version at the head it reported.
  const current = useQuery({
    ...orpc.documents.get.queryOptions({
      input: { kbId, path, ...(against ? { rev: against.headSha } : {}) },
    }),
    ...quiet,
    enabled: open,
    staleTime: 0,
  });
  const { restore, pending } = useDocumentRestore();
  // A denial (not a missing path) rechecks the KB; a lost KB shows nothing
  // cached here and its drafts are dropped (`forgetKb`).
  const lost = useKbAccessLoss(kbId, [source.error, current.error]);
  const [failure, setFailure] = useState<EditorOutcome | null>(null);
  const { deleted, now, ready, head, same } = restoreTarget({
    source: source.isSuccess ? source.data : undefined,
    current,
    against,
    kbHeadSha,
  });
  const rows =
    ready && source.data
      ? compactDiff(lineDiff(deleted ? null : (now?.markdown ?? ""), source.data.markdown))
      : [];
  const close = (next: boolean) => {
    if (pending) return;
    if (!next) {
      setAgainst(null);
      setFailure(null);
    }
    onOpenChange(next);
  };

  const confirm = async () => {
    setFailure(null);
    const outcome = await restore({
      kbId,
      path,
      revision,
      ...(sourcePath && sourcePath !== path ? { sourcePath } : {}),
      current: { exists: !deleted, head },
      ...(against ? { rebase: against } : {}),
    });
    if (!outcome) return;
    switch (outcome.kind) {
      case "applied":
      case "noop":
        toast.success(t("restore.restored", { path }));
        onRestored(outcome);
        return;
      case "proposed":
        toast.success(
          t(outcome.created ? "outcome.proposalCreatedTitle" : "outcome.proposedTitle", {
            number: outcome.proposalNumber,
          }),
        );
        onRestored(outcome);
        return;
      case "conflict": {
        // Show the version at the reported head (main's, or the caller's own
        // pull request's); confirming again writes onto exactly that head.
        const next = confirmableConflict(outcome, { kind: "document", path });
        if (next && next.headSha !== against?.headSha) setAgainst(next);
        else void current.refetch();
        setFailure(outcome);
        return;
      }
      default:
        setFailure(outcome);
    }
  };

  return (
    <Dialog open={open && !lost} onOpenChange={close}>
      <DialogContent
        data-testid="restore-dialog"
        className="max-h-[90svh] overflow-y-auto overflow-x-hidden sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>{t("restore.title")}</DialogTitle>
          <DialogDescription>
            {t(
              deleted
                ? proposing
                  ? "restore.descriptionDeletedProposal"
                  : "restore.descriptionDeleted"
                : proposing
                  ? "restore.descriptionProposal"
                  : "restore.description",
              { path, sha: revision.slice(0, 7) },
            )}
          </DialogDescription>
        </DialogHeader>
        {source.isError || (current.isError && !deleted) ? (
          <InlineRetry
            message={t("restore.loadFailed")}
            onRetry={() => {
              if (source.isError) void source.refetch();
              if (current.isError) void current.refetch();
            }}
          />
        ) : !ready ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : same ? (
          <p role="status" className="rounded-md border p-3 text-sm">
            {t("restore.same")}
          </p>
        ) : (
          <section className="min-w-0 space-y-2" aria-label={t("restore.changesLabel")}>
            <p className="text-sm text-muted-foreground">
              {t(deleted ? "restore.diffDeleted" : "restore.diffHint")}
            </p>
            <div
              data-testid="restore-diff"
              className="max-h-[45svh] overflow-x-auto overflow-y-auto whitespace-pre rounded-md border p-3 font-mono text-xs"
            >
              {rows.map((row, index) =>
                row.kind === "gap" ? (
                  <span key={index} className="block py-1 text-muted-foreground italic">
                    {t("restore.unchangedLines", { count: row.count })}
                  </span>
                ) : (
                  <span
                    key={index}
                    className={
                      row.kind === "added"
                        ? "block bg-green-500/10"
                        : row.kind === "removed"
                          ? "block bg-red-500/10"
                          : "block"
                    }
                  >
                    <span aria-hidden>
                      {row.kind === "added" ? "+" : row.kind === "removed" ? "-" : " "}
                    </span>
                    <span className="sr-only">
                      {row.kind === "added"
                        ? t("restore.lineAdded")
                        : row.kind === "removed"
                          ? t("restore.lineRemoved")
                          : ""}
                    </span>
                    {row.text}
                  </span>
                ),
              )}
            </div>
          </section>
        )}
        {failure && (
          <RestoreFailure lang={lang} kbId={kbId} outcome={failure} confirmable={against} />
        )}
        <DialogFooter>
          <Button
            variant="outline"
            className="min-h-[44px]"
            disabled={pending}
            onClick={() => close(false)}
          >
            {t("restore.cancel")}
          </Button>
          <Button
            data-testid="restore-confirm"
            className="min-h-[44px]"
            disabled={!ready || same || pending || current.isFetching}
            onClick={() => void confirm()}
          >
            {pending
              ? t("restore.pending")
              : proposing
                ? t("restore.confirmProposal")
                : t("restore.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RestoreFailure({
  lang,
  kbId,
  outcome,
  confirmable,
}: {
  lang: string;
  kbId: string;
  outcome: EditorOutcome;
  /** The head a conflict may be confirmed against (shown above), if any. */
  confirmable: Rebase | null;
}) {
  const { t } = useTranslation("kb");
  if (outcome.kind === "conflict")
    return (
      <div role="alert" className="space-y-2 text-sm text-destructive">
        <p>
          {outcome.proposalNumber === null
            ? t("restore.conflict")
            : confirmable?.proposalNumber === outcome.proposalNumber
              ? t("restore.conflictInProposal", { number: outcome.proposalNumber })
              : t("restore.conflictProposal", { number: outcome.proposalNumber })}
        </p>
        {outcome.proposalNumber !== null && (
          <Link
            to="/$lang/kbs/$kbId/prs/$number"
            params={{ lang, kbId, number: String(outcome.proposalNumber) }}
            className="inline-flex min-h-[44px] items-center underline"
          >
            {t("outcome.openProposal", { number: outcome.proposalNumber })}
          </Link>
        )}
      </div>
    );
  return (
    <p role="alert" className="text-sm text-destructive">
      {outcome.kind === "retryable"
        ? t("editor.retryable")
        : outcome.kind === "error" && outcome.pathIssue === "exists"
          ? t("restore.exists")
          : outcome.kind === "error" && outcome.reason !== "unknown"
            ? t(`editor.${outcome.reason}`)
            : t("editor.error")}
    </p>
  );
}

type VersionRead = { markdown: string; commitSha: string } | null | undefined;

/**
 * What a restore writes onto: the document at `against` (a conflict's
 * reported head) or main now, or none (deleted there). A failed refetch
 * keeps its earlier data in the cache (e.g. the version from before a
 * delete): only a successful read describes the document now.
 */
export function restoreTarget({
  source,
  current,
  against,
  kbHeadSha,
}: {
  source: VersionRead;
  current: { data: VersionRead; error: unknown; isError: boolean };
  against: Rebase | null;
  kbHeadSha: string;
}) {
  const deleted = isPathNotFound(current.error);
  const now = current.isError ? undefined : (current.data ?? undefined);
  const ready = Boolean(source) && (now !== undefined || deleted);
  const head = against?.headSha ?? now?.commitSha ?? kbHeadSha;
  const same = ready && !deleted && now?.markdown === source?.markdown;
  return { deleted, now, ready, head, same };
}

/** One document's own deletion: the deleted scan, for that path only. */
export function deletedDocumentInput(kbId: string, path: string) {
  return { kbId, path, limit: 1 };
}

/**
 * A document main no longer has. When main's history deleted it (the
 * deleted scan, merges included), it says so (when, by whom) and offers its
 * last version: open it, or restore it as a new revision. Otherwise the path
 * never existed on main (or the reader can't tell): the plain not-found line.
 */
export function DeletedDocumentNotice({
  lang,
  kbId,
  kbHeadSha,
  canRestore,
  proposing,
  path,
  onRestored,
}: {
  lang: string;
  kbId: string;
  kbHeadSha: string | null;
  canRestore: boolean;
  proposing: boolean;
  path: string;
  onRestored: (outcome: Extract<EditorOutcome, { kind: "applied" | "noop" | "proposed" }>) => void;
}) {
  const { t } = useTranslation("kb");
  const [restoring, setRestoring] = useState(false);
  // The same first-parent scan as the KB's "Recently deleted" list, for this
  // path: the page and the list agree on the deletion, merges included.
  const { data, error, isPending, isError, refetch } = useQuery({
    ...orpc.documents.deleted.queryOptions({ input: deletedDocumentInput(kbId, path) }),
    retry: false,
  });
  // A denial hides the cached row (who deleted it, when) and rechecks the KB.
  const lost = useKbAccessLoss(kbId, [error]);
  const denied = lost || isQueryAccessError(error);
  const deletion = denied ? undefined : data?.items.find((row) => row.path === path);
  if (isPending) return <Skeleton className="h-16 w-full" />;
  // A failed lookup is not an answer: never "doesn't exist" on a transient error.
  if (!deletion && isError && !denied)
    return <InlineRetry message={t("document.deletedLoadFailed")} onRetry={() => refetch()} />;
  if (!deletion)
    return (
      <p role="status" className="rounded-md border p-4 text-sm">
        {t("document.notFound")}
      </p>
    );
  // The deleting commit's first parent: where the last version is.
  const last = deletion.revision;
  return (
    <div
      role="status"
      data-testid="document-deleted"
      className="min-w-0 space-y-3 rounded-md border p-4 text-sm"
    >
      <p className="font-medium">
        {deletion.deletedAt
          ? t("document.deletedOn", {
              date: new Date(deletion.deletedAt).toLocaleString(lang, {
                year: "numeric",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              }),
              actor: actorLine(t, deletion.actor),
            })
          : t("document.deleted")}
      </p>
      <p>{t("document.deletedRecoverable")}</p>
      <div className="flex flex-wrap gap-2">
        {canRestore && kbHeadSha && (
          <Button
            data-testid="document-restore-last"
            className="min-h-[44px]"
            onClick={() => setRestoring(true)}
          >
            {proposing ? t("restore.proposeLast") : t("restore.restoreLast")}
          </Button>
        )}
        <Link
          to="/$lang/kbs/$kbId/documents"
          params={{ lang, kbId }}
          search={{ path, rev: last }}
          className={cn(buttonVariants({ variant: "outline", size: "touch" }))}
        >
          {t("restore.viewLast")}
        </Link>
      </div>
      {kbHeadSha && (
        <RestoreVersionDialog
          lang={lang}
          kbId={kbId}
          kbHeadSha={kbHeadSha}
          proposing={proposing}
          path={path}
          revision={last}
          open={restoring}
          onOpenChange={setRestoring}
          onRestored={(outcome) => {
            setRestoring(false);
            onRestored(outcome);
          }}
        />
      )}
    </div>
  );
}
