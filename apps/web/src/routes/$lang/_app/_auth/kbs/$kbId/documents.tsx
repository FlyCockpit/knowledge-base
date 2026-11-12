import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { env } from "@knowledge-base/env/web";
import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@knowledge-base/ui/components/dialog";
import { toast } from "@knowledge-base/ui/components/sileo";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { cn } from "@knowledge-base/ui/lib/utils";
import { skipToken, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Download, Pencil } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import {
  KbDocumentDelete,
  KbProposalDocumentEditor,
  KbSessionEditor,
} from "@/components/kb/document-editor";
import { KbDownloads } from "@/components/kb/downloads";
import { KbRenderedDocument } from "@/components/kb/markdown-view";
import { StatusPill } from "@/components/status-pill";
import {
  type EditingTarget,
  isPathNotFound,
  kbControls,
  useKbAccessLoss,
  useKbEditor,
} from "@/hooks/use-kb-editor";
import { cachedKbName, pageHead } from "@/lib/page-title";
import { orpc } from "@/utils/orpc";

/**
 * `proposal`: the writer's pull request this document is being edited in.
 * It lives in the URL so a reload, or leaving and coming back, reopens
 * the proposal's version and keeps extending that same PR.
 * `pr`: PR mode (R3-W6), resolving this document's version in that pull
 * request against main; it has its own session (`KbProposalDocumentEditor`).
 */
type DocumentSearch = {
  path?: string;
  rev?: string;
  mode?: "new" | "edit";
  proposal?: number;
  pr?: number;
};

const proposalParam = (value: unknown) => {
  const n = typeof value === "string" && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

const SHA = /^[0-9a-f]{40}$/;
const PR_NUMBER = /^[1-9]\d{0,15}$/;

/** A pull request number, only alongside `mode=edit` and a path. */
function prSearch(search: Record<string, unknown>): number | undefined {
  if (search.mode !== "edit" || typeof search.path !== "string") return undefined;
  const raw = typeof search.pr === "number" ? String(search.pr) : search.pr;
  if (typeof raw !== "string" || !PR_NUMBER.test(raw)) return undefined;
  const number = Number(raw);
  return Number.isSafeInteger(number) ? number : undefined;
}

const validateDocumentSearch = (search: Record<string, unknown>): DocumentSearch => ({
  path:
    typeof search.path === "string" && search.path.length > 0 && search.path.length <= 512
      ? search.path
      : undefined,
  rev: typeof search.rev === "string" && SHA.test(search.rev) ? search.rev : undefined,
  mode: search.mode === "new" || search.mode === "edit" ? search.mode : undefined,
  proposal: proposalParam(search.proposal),
  pr: prSearch(search),
});

export const Route = createFileRoute("/$lang/_app/_auth/kbs/$kbId/documents")({
  validateSearch: validateDocumentSearch,
  head: ({ match, params }) =>
    pageHead(
      match.search.mode === "new" || !match.search.path
        ? match.context.i18n.t("kb:detail.newDocument")
        : match.search.path.slice(match.search.path.lastIndexOf("/") + 1),
      cachedKbName(match.context.queryClient, params.kbId),
    ),
  component: DocumentPage,
});

const short = (sha: string) => sha.slice(0, 12);

/*
 * Ownership rules of this page (R5 review). Each concern has one owner, so no
 * render guard has to reconcile them:
 *
 * 1. Navigation authority. Only the router's latest requested location
 *    (`router.latestLocation`, which already holds a navigation whose loaders
 *    are still pending) says where the user is. Being mounted is not
 *    authority: a page stays mounted while its successor loads. A completion
 *    (save receipt, create, delete) changes the URL only through
 *    `latestDocumentAt()`, and only while that location still names the
 *    completion's own origin target. It then rewrites the target parameters
 *    alone, so a mode the user chose meanwhile (Done editing) stays.
 * 2. Target availability. Whether the URL's target is open, CLOSED/MERGED,
 *    missing or unreadable comes from its queries alone and renders whether or
 *    not a draft exists. A terminal proposal always shows its notice and Open
 *    main, and no write is offered against it. A proposal head without the
 *    path (PATH_NOT_FOUND) is a state of its own, never a failed read: its
 *    base read says deleted in the proposal or never part of it, and no
 *    Delete is offered. The same holds for a session whose own receipt
 *    deleted it.
 * 3. Draft lifetime. An editor session (`useKbEditor`) owns its draft and its
 *    write target: the document it writes (path, existence, head), the
 *    proposal it edits and its unresolved save record. Every receipt,
 *    including one recovered after a lost reply, updates that one object, and
 *    a changed target is reported here (rule 1) — also a new draft's create,
 *    whose target is "New document" (path "") until then. The session lives
 *    while the URL names its target (or, for the instant its own receipt
 *    navigates, the target it moved from). It never supplies read-view bytes
 *    or availability. A receipt the user has navigated away from retires its
 *    session instead of moving it.
 *
 * PR mode (`pr`) is a separate view with its own session; it never moves.
 */

/** The "New document" target: a draft no save has placed yet. */
const newTarget = (kbId: string): EditingTarget => ({
  kbId,
  path: "",
  target: { kind: "main", rev: null },
});

/** The URL's editing target: KB, path and main (optionally pinned) or a named proposal. */
function targetOf(kbId: string, search: DocumentSearch): EditingTarget | null {
  if (search.pr !== undefined) return null;
  if (search.mode === "new" || !search.path) return newTarget(kbId);
  return search.proposal !== undefined
    ? { kbId, path: search.path, target: { kind: "proposal", number: search.proposal } }
    : { kbId, path: search.path, target: { kind: "main", rev: search.rev ?? null } };
}

/** Rule 1: this page's search at the router's latest requested location, if it is this KB's document page. */
function latestDocumentAt(
  router: ReturnType<typeof useRouter>,
  kbId: string,
): { lang: string; search: DocumentSearch } | null {
  const latest = router.latestLocation;
  const [, params, route] = router.getMatchedRoutes(latest.pathname);
  if (route?.id !== Route.id || params.kbId !== kbId || !params.lang) return null;
  return {
    lang: params.lang,
    search: validateDocumentSearch(latest.search as Record<string, unknown>),
  };
}

/**
 * Read-first document page: a document header (path, revision
 * and the document's actions), then the rendered document. Edit switches to
 * the split editor/preview; KB-level actions live on the KB page, not here.
 */
function DocumentPage() {
  const { lang, kbId } = Route.useParams();
  const search = Route.useSearch();
  const { t } = useTranslation("kb");
  // The parent layout only renders this route once `kbs.get` has data.
  const { data: kbData } = useQuery(orpc.kbs.get.queryOptions({ input: { kbId }, staleTime: 0 }));
  // The one editing target: its read, its availability and its session follow it.
  const target = targetOf(kbId, search);
  const isNew = target !== null && target.path === "";
  const proposalNumber = target?.target.kind === "proposal" ? target.target.number : null;
  // Rule 2. A named proposal is a required dependency, including on re-entry.
  // Never turn a failed lookup into an unpinned main read.
  const proposalRead = useQuery({
    ...orpc.pullRequests.get.queryOptions({
      input: proposalNumber === null ? skipToken : { kbId, number: proposalNumber },
    }),
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
  });
  const pr = proposalRead.data?.pr;
  const proposalOpen = pr?.status === "OPEN" || pr?.status === "CONFLICT";
  // CLOSED or MERGED, as last reported for this exact proposal.
  const terminal = proposalNumber !== null && pr !== undefined && !proposalOpen;
  // The proposal as last read since this page mounted: a cached answer from
  // an earlier visit never stands in for it. A refetch (focus, a save's
  // invalidation) keeps it, so the reads below stay keyed on its head and
  // keep their data; a head that moves re-keys them.
  const proposalResolved =
    proposalRead.isSuccess && proposalRead.isFetchedAfterMount && pr !== undefined && proposalOpen;
  const documentRead = useQuery({
    ...orpc.documents.get.queryOptions({
      input:
        !target || isNew || (proposalNumber !== null && !proposalResolved)
          ? skipToken
          : {
              kbId: target.kbId,
              path: target.path,
              ...(target.target.kind === "proposal"
                ? { rev: pr!.headSha }
                : target.target.rev
                  ? { rev: target.target.rev }
                  : {}),
            },
    }),
    retry: false,
    staleTime: target?.target.kind === "main" && !target.target.rev ? 0 : undefined,
  });
  // Rule 2: a proposal head without this path is a state of its own. Its
  // base says which: deleted in the proposal, or never part of it.
  const missingAtHead = proposalNumber !== null && isPathNotFound(documentRead.error);
  const baseRead = useQuery({
    ...orpc.documents.get.queryOptions({
      input:
        !target || !missingAtHead || !proposalResolved
          ? skipToken
          : { kbId: target.kbId, path: target.path, rev: pr!.baseSha },
    }),
    retry: false,
  });
  const absence: Absence | null = !missingAtHead
    ? null
    : baseRead.isSuccess
      ? { deleted: true }
      : isPathNotFound(baseRead.error)
        ? { deleted: false }
        : null;
  const missingFailed = missingAtHead && baseRead.isError && absence === null;
  // Rule 3. `from` is the target this session's own receipt is navigating
  // away from, until the URL arrives at `target`.
  const targetKey = target ? editingTargetKey(target) : null;
  const [session, setSession] = useState<{
    id: string;
    target: EditingTarget;
    from?: string;
  } | null>(null);
  let live = session;
  if (live && targetKey === editingTargetKey(live.target) && live.from) {
    live = { ...live, from: undefined };
    setSession(live);
  }
  if (
    live &&
    (targetKey === null || (targetKey !== editingTargetKey(live.target) && targetKey !== live.from))
  ) {
    live = null;
    setSession(null);
  }
  const read = documentRead.data;
  const expectedRevision = target?.target.kind === "proposal" ? pr?.headSha : target?.target.rev;
  // Read-view bytes: only the successful read of exactly this target.
  const document =
    target &&
    !isNew &&
    read &&
    documentRead.isSuccess &&
    read.path === target.path &&
    (!expectedRevision || read.commitSha === expectedRevision) &&
    (proposalNumber === null || proposalResolved)
      ? read
      : null;
  // A new draft needs no read; any other session opens on its target's read.
  if (!live && target && (isNew || document)) {
    live = { id: crypto.randomUUID(), target };
    setSession(live);
  }
  useKbAccessLoss(kbId, [documentRead.error, proposalRead.error, baseRead.error]);
  const navigate = useNavigate();
  const router = useRouter();
  const goTo = (target: DocumentSearch, replace = false) =>
    navigate({
      to: "/$lang/kbs/$kbId/documents",
      params: { lang, kbId },
      search: target,
      replace,
      resetScroll: false,
    });
  /**
   * Rule 1 for a session's receipts. Runs when the write completes, possibly
   * from a closure of an earlier render: everything it decides on is read now.
   */
  const advanceSession = (id: string, next: EditingTarget, previous: EditingTarget) => {
    const at = latestDocumentAt(router, previous.kbId);
    const latest = at && targetOf(previous.kbId, at.search);
    const owned =
      at && latest && editingTargetKey(latest) === editingTargetKey(previous) ? at : null;
    setSession((current) =>
      current?.id !== id
        ? current
        : owned
          ? { ...current, target: next, from: editingTargetKey(previous) }
          : null,
    );
    if (!owned) return;
    void navigate({
      to: "/$lang/kbs/$kbId/documents",
      params: { lang: owned.lang, kbId: previous.kbId },
      search: {
        ...owned.search,
        path: next.path,
        // A created draft keeps editing at its new path.
        mode: owned.search.mode === "new" ? "edit" : owned.search.mode,
        proposal: next.target.kind === "proposal" ? next.target.number : undefined,
        rev: undefined,
      },
      replace: true,
      resetScroll: false,
    });
  };
  const onDeleted = (from: EditingTarget) => {
    const at = latestDocumentAt(router, from.kbId);
    const latest = at && targetOf(from.kbId, at.search);
    if (!latest || editingTargetKey(latest) !== editingTargetKey(from)) return;
    void navigate({ to: "/$lang/kbs/$kbId", params: { lang: at.lang, kbId: from.kbId } });
  };
  if (!kbData) return null;
  const kb = kbData.kb;
  if (search.pr !== undefined && search.path) {
    const path = search.path;
    const slash = path.lastIndexOf("/");
    return (
      <div className="min-w-0 space-y-6">
        <DocumentHeader
          title={path.slice(slash + 1)}
          folder={slash >= 0 ? path.slice(0, slash + 1) : undefined}
          meta={<StatusPill tone="busy">{t("prMode.pill", { number: search.pr })}</StatusPill>}
        />
        <KbProposalDocumentEditor
          key={`${kbId}:${path}#${search.pr}`}
          lang={lang}
          kb={kb}
          number={search.pr}
          path={path}
          onLeave={() => goTo({ path })}
        />
      </div>
    );
  }
  if (!target) return null;
  // Rule 2: shown for a terminal proposal whether or not a draft exists.
  const closedNotice = terminal && (
    <div role="status" className="space-y-3 rounded-md border p-4 text-sm">
      <p>
        {t("document.proposalClosed", {
          number: target.target.kind === "proposal" ? target.target.number : 0,
        })}
      </p>
      <Button
        variant="outline"
        className="min-h-[44px]"
        onClick={() => goTo({ path: target.path })}
      >
        {t("document.openMain")}
      </Button>
    </div>
  );
  const proposalFailed = proposalNumber !== null && proposalRead.isError;
  const retryProposal = () => void proposalRead.refetch();
  // A failed read of this target, other than the absence it reports.
  const missingDocument = proposalNumber === null && isPathNotFound(documentRead.error);
  const readFailed = (documentRead.isError && !missingAtHead && !missingDocument) || missingFailed;
  const retryRead = () => void (missingFailed ? baseRead.refetch() : documentRead.refetch());
  if (!live) {
    if (closedNotice) return closedNotice;
    if (absence && proposalNumber !== null)
      return (
        <AbsenceNotice
          lang={lang}
          kbId={kbId}
          proposalNumber={proposalNumber}
          absence={absence}
          onOpenMain={() => goTo({ path: target.path })}
        />
      );
    if (proposalFailed)
      return (
        <InlineRetry
          message={t("document.proposalLoadFailed", { number: proposalNumber })}
          onRetry={retryProposal}
        />
      );
    if (proposalNumber === null && isPathNotFound(documentRead.error))
      return (
        <p role="status" className="rounded-md border p-4 text-sm">
          {t("document.notFound")}
        </p>
      );
    if (readFailed) return <InlineRetry message={t("editor.loadFailed")} onRetry={retryRead} />;
    return (
      <div className="space-y-4">
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-[50svh] w-full max-w-[72ch]" />
      </div>
    );
  }
  const sessionId = live.id;
  // A failed read leaves the live draft mounted, but supplies no read-view
  // bytes. The layout handles lost KB access and clears cached content.
  return (
    <div className="min-w-0 space-y-4">
      {closedNotice}
      {proposalFailed && (
        <InlineRetry
          variant="destructive"
          message={t("document.proposalLoadFailed", { number: proposalNumber })}
          onRetry={retryProposal}
        />
      )}
      {missingDocument && (
        <p role="status" className="rounded-md border p-4 text-sm">
          {t("document.notFound")}
        </p>
      )}
      {readFailed && (
        <InlineRetry variant="destructive" message={t("editor.loadFailed")} onRetry={retryRead} />
      )}
      <DocumentView
        // Identity belongs to the explicit session, even as its own receipts
        // advance its target (a create included). Only navigation creates
        // another identity.
        key={sessionId}
        lang={lang}
        kb={kb}
        document={document}
        absence={absence}
        open={!terminal}
        search={search}
        target={live.target}
        onAdvance={(next, previous) => advanceSession(sessionId, next, previous)}
        goTo={goTo}
        onDeleted={onDeleted}
      />
    </div>
  );
}

function editingTargetKey(target: EditingTarget) {
  return JSON.stringify([
    target.kbId,
    target.path,
    target.target.kind,
    target.target.kind === "main" ? target.target.rev : target.target.number,
  ]);
}

type ViewKb = NonNullable<Awaited<ReturnType<AppRouterClient["kbs"]["get"]>>>["kb"];
type ViewDocument = NonNullable<Awaited<ReturnType<AppRouterClient["documents"]["get"]>>>;

function DocumentView({
  lang,
  kb,
  document,
  absence: proposalAbsence,
  open,
  search,
  target,
  goTo,
  onDeleted,
  onAdvance,
}: {
  lang: string;
  kb: ViewKb;
  document: ViewDocument | null;
  /** Rule 2: the named proposal's head has no document at this path. */
  absence: Absence | null;
  /** Rule 2: false for a CLOSED or MERGED proposal. The draft stays, writes do not. */
  open: boolean;
  search: DocumentSearch;
  target: EditingTarget;
  onAdvance: (next: EditingTarget, previous: EditingTarget) => void;
  goTo: (target: DocumentSearch, replace?: boolean) => void;
  onDeleted: (from: EditingTarget) => void;
}) {
  const { t } = useTranslation("kb");
  const kbId = target.kbId;
  const proposal = target.target.kind === "proposal" ? target.target : null;
  // A new draft ("New document") until its create receipt moves the target.
  const draft = target.path === "";
  const editor = useKbEditor({
    target,
    // A session mounts only with a matching successful read, or as a new
    // draft on the KB head. Later read failures do not reinitialize this
    // hook or replace its live draft.
    initialMarkdown: document?.markdown ?? "",
    baseRevision: document?.commitSha ?? kb.headSha ?? "",
    initialExists: !draft,
    onTargetAdvance: onAdvance,
  });
  const onProposed = (number: number, created: boolean) => {
    if (proposal?.number === number) return;
    toast.success(
      t(created ? "outcome.proposalCreatedTitle" : "outcome.proposedTitle", { number }),
    );
  };
  const pinned =
    target.target.kind === "main" && target.target.rev !== kb.headSha ? target.target.rev : null;
  const controls = kbControls(kb.capabilities);
  // Rule 2: absent at the target, by the proposal's change set or by this
  // session's own delete receipt. Nothing is read there and nothing deleted.
  const absence: Absence | null =
    proposalAbsence ?? (!draft && !editor.exists ? { deleted: true } : null);
  // A deleted document with no draft of its own left is a final state.
  const gone = absence !== null && !editor.exists;
  // Without a branch head there is no base revision to write against.
  const writable = kb.headSha !== null && controls.editMode !== "none" && pinned === null && open;
  // "new" stays editing while a create's own navigation to `mode=edit` is pending.
  const editing = draft || search.mode === "edit" || search.mode === "new";
  const at = {
    path: target.path,
    ...(target.target.kind === "proposal"
      ? { proposal: target.target.number }
      : target.target.rev
        ? { rev: target.target.rev }
        : {}),
  };
  const slash = target.path.lastIndexOf("/");

  return (
    <div className="min-w-0 space-y-6">
      <DocumentHeader
        title={draft ? t("detail.newDocument") : target.path.slice(slash + 1)}
        mono={!draft}
        folder={slash >= 0 ? target.path.slice(0, slash + 1) : undefined}
        meta={
          !draft && (
            <>
              <StatusPill tone="muted" className="font-mono">
                {t("document.revision", { sha: short(document?.commitSha ?? editor.baseRevision) })}
              </StatusPill>
              {pinned && <StatusPill tone="busy">{t("document.olderRevision")}</StatusPill>}
              {proposal && (
                <Link
                  to="/$lang/kbs/$kbId/prs/$number"
                  params={{ lang, kbId, number: String(proposal.number) }}
                  className="rounded-full underline-offset-2 hover:underline"
                >
                  <StatusPill tone="busy">
                    {t("document.inProposal", { number: proposal.number })}
                  </StatusPill>
                </Link>
              )}
            </>
          )
        }
        actions={
          !draft && (
            <>
              {gone ? null : editing ? (
                <Link
                  to="/$lang/kbs/$kbId/documents"
                  params={{ lang, kbId }}
                  search={at}
                  className={cn(buttonVariants({ variant: "outline", size: "touch" }))}
                >
                  {t("document.doneEditing")}
                </Link>
              ) : (
                writable && (
                  <Link
                    to="/$lang/kbs/$kbId/documents"
                    params={{ lang, kbId }}
                    search={{ ...at, mode: "edit" }}
                    data-testid="document-edit"
                    className={buttonVariants({ size: "touch" })}
                  >
                    <Pencil aria-hidden className="size-4" />
                    {controls.editMode === "direct" ? t("document.edit") : t("document.suggest")}
                  </Link>
                )
              )}
              {!editing && document && <DownloadDialog kbId={kbId} rev={document.commitSha} />}
              {writable && !absence && (
                <KbDocumentDelete
                  lang={lang}
                  kbId={kbId}
                  editor={editor}
                  proposing={controls.editMode === "proposal"}
                  onDeleted={() => onDeleted(target)}
                />
              )}
            </>
          )
        }
      />
      {absence && (
        <AbsenceNotice
          lang={lang}
          kbId={kbId}
          proposalNumber={proposal?.number ?? null}
          absence={absence}
          onOpenMain={() => goTo({ path: target.path })}
        />
      )}
      {writable && !draft && !proposal && !absence && (
        <ProposalNotice lang={lang} kbId={kbId} path={target.path} editing={editing} />
      )}
      {pinned && !editing && (
        <div
          role="status"
          className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          <p>{t("editor.oldRevision", { sha: short(pinned) })}</p>
          <Button
            variant="outline"
            className="mt-2 min-h-[44px]"
            onClick={() => goTo({ path: target.path })}
          >
            {t("editor.openLatest")}
          </Button>
        </div>
      )}
      {gone ? null : editing ? (
        <KbSessionEditor
          lang={lang}
          kb={kb}
          isNew={draft}
          editor={editor}
          closed={!open}
          viewingRevision={pinned}
          preview={{ rev: editor.baseRevision, assets: document?.assetRefs ?? [] }}
          onOpenLatest={(path) => goTo({ path, mode: "edit" })}
          onProposed={(number, created) => void onProposed(number, created)}
        />
      ) : document ? (
        // Rendered at the commit the document was read at, so media stay pinned to it.
        <KbRenderedDocument lang={lang} kbId={kbId} document={document} showRevision={false} />
      ) : null}
    </div>
  );
}

/** A target with no document at its path: deleted there, or never there. */
type Absence = { deleted: boolean };

/**
 * Rule 2: the target names a path its revision does not have. In a proposal
 * that is the proposal's own change (deleted in it, or not part of it), with
 * the main version and the pull request one step away.
 */
function AbsenceNotice({
  lang,
  kbId,
  proposalNumber,
  absence,
  onOpenMain,
}: {
  lang: string;
  kbId: string;
  proposalNumber: number | null;
  absence: Absence;
  onOpenMain: () => void;
}) {
  const { t } = useTranslation("kb");
  return (
    <div
      role="status"
      data-testid="document-absent"
      className="space-y-3 rounded-md border p-4 text-sm"
    >
      <p>
        {proposalNumber === null
          ? t("document.deleted")
          : t(absence.deleted ? "document.deletedInProposal" : "document.notInProposal", {
              number: proposalNumber,
            })}
      </p>
      {proposalNumber !== null && (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="min-h-[44px]" onClick={onOpenMain}>
            {t("document.openMain")}
          </Button>
          <Link
            to="/$lang/kbs/$kbId/prs/$number"
            params={{ lang, kbId, number: String(proposalNumber) }}
            className={cn(buttonVariants({ variant: "outline", size: "touch" }))}
          >
            {t("outcome.openProposal", { number: proposalNumber })}
          </Link>
        </div>
      )}
    </div>
  );
}

/**
 * The viewer's own open pull request already changes this document (R3-W6):
 * say so, so editing never silently starts from main's version over it.
 */
function ProposalNotice({
  lang,
  kbId,
  path,
  editing,
}: {
  lang: string;
  kbId: string;
  path: string;
  editing: boolean;
}) {
  const { t } = useTranslation("kb");
  const { data: proposal } = useQuery(
    orpc.pullRequests.forDocument.queryOptions({ input: { kbId, path }, retry: false }),
  );
  if (!proposal || proposal.isDream) return null;
  return (
    <div
      role="status"
      data-testid="document-proposal-notice"
      className="min-w-0 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <p className="font-medium">{t("prMode.notice", { number: proposal.number })}</p>
      <p>{t(editing ? "prMode.noticeEditing" : "prMode.noticeBody")}</p>
      <div className="flex flex-wrap gap-2">
        <Link
          to="/$lang/kbs/$kbId/documents"
          params={{ lang, kbId }}
          search={{ path, mode: "edit", pr: proposal.number }}
          data-testid="document-proposal-edit"
          className={buttonVariants({ size: "touch" })}
        >
          {t("prMode.editInPr", { number: proposal.number })}
        </Link>
        <Link
          to="/$lang/kbs/$kbId/prs/$number"
          params={{ lang, kbId, number: String(proposal.number) }}
          className={cn(buttonVariants({ variant: "outline", size: "touch" }))}
        >
          {t("outcome.openProposal", { number: proposal.number })}
        </Link>
      </div>
    </div>
  );
}

function DocumentHeader({
  title,
  folder,
  meta,
  actions,
  mono = true,
}: {
  title: string;
  /** File names are monospace; a plain heading ("New document") is not. */
  mono?: boolean;
  folder?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
      <header className="min-w-0 space-y-1.5">
        {folder && <p className="truncate font-mono text-xs text-muted-foreground">{folder}</p>}
        <h1 className={cn("text-lg font-semibold break-all sm:text-xl", mono && "font-mono")}>
          {title}
        </h1>
        {meta && <div className="flex flex-wrap items-center gap-2">{meta}</div>}
      </header>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/** Download → Dialog: the ZIP exports and the Git clone URL for this revision. */
function DownloadDialog({ kbId, rev }: { kbId: string; rev: string }) {
  const { t } = useTranslation("kb");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size="touch" onClick={() => setOpen(true)}>
        <Download aria-hidden className="size-4" />
        {t("document.download")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90svh] overflow-y-auto overflow-x-hidden sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("document.downloadTitle")}</DialogTitle>
            <DialogDescription>{t("document.downloadDescription")}</DialogDescription>
          </DialogHeader>
          <KbDownloads
            kbId={kbId}
            rev={rev}
            origin={env.VITE_SERVER_URL}
            prepare={orpc.kbExports.prepare.mutationOptions()}
            complete={orpc.kbExports.complete.mutationOptions()}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
