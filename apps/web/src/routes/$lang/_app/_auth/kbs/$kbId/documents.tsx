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
import { skipToken, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { Download, Pencil } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import {
  DocumentMoreMenu,
  type EditorSaveHandle,
  KbDocumentDelete,
  KbProposalDocumentEditor,
  KbSessionEditor,
  type MoreAction,
} from "@/components/kb/document-editor";
import {
  actorLine,
  DocumentHistory,
  documentHistoryOptions,
  ProvenanceBadge,
  visibleHistoryRows,
} from "@/components/kb/document-history";
import { DocumentMoveSheet, documentMoveAction } from "@/components/kb/document-move-sheet";
import { DeletedDocumentNotice, RestoreVersionDialog } from "@/components/kb/document-restore";
import { KbDownloads } from "@/components/kb/downloads";
import { KbRenderedDocument } from "@/components/kb/markdown-view";
import { StatusPill } from "@/components/status-pill";
import {
  clearDraft,
  draftKey,
  readDraft,
  type StoredDraft,
  useDocumentDraft,
} from "@/hooks/use-document-draft";
import { useDocumentRestore } from "@/hooks/use-document-restore";
import {
  type EditingTarget,
  isPathNotFound,
  kbControls,
  useKbAccessLoss,
  useKbEditor,
} from "@/hooks/use-kb-editor";
import { useWorkspaceEditorRegistration } from "@/hooks/use-workspace-editor-registration";
import { useWorkspaceFileRequest } from "@/hooks/use-workspace-file-request";
import { useWorkspaceNoEditor } from "@/hooks/use-workspace-no-editor";
import { documentTitle } from "@/lib/document-text";
import { cachedKbName, pageHead } from "@/lib/page-title";
import { orpc } from "@/utils/orpc";
import { formatRelativeTime } from "@/utils/relative-time";

/**
 * `proposal`: the writer's pull request this document is being edited in.
 * It lives in the URL so a reload, or leaving and coming back, reopens
 * the proposal's version and keeps extending that same PR.
 * `pr`: PR mode, resolving this document's version in that pull
 * request against main; it has its own session (`KbProposalDocumentEditor`).
 */
type DocumentSearch = {
  path?: string;
  rev?: string;
  /**
   * With `rev`: the document's name now, when `path` is the name it had at
   * that revision (a history row from before a rename). Restoring and "open
   * the latest version" go there; the revision is read at `path`.
   */
  restoreTo?: string;
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
  restoreTo:
    typeof search.restoreTo === "string" &&
    search.restoreTo.length > 0 &&
    search.restoreTo.length <= 512 &&
    typeof search.rev === "string"
      ? search.restoreTo
      : undefined,
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
 * Ownership rules of this page. Each concern has one owner, so no
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
  // Whose drafts this tab keeps: the session the protected layout resolved
  // before this page rendered (never a client session still loading).
  const { session: signedIn } = Route.useRouteContext();
  const draftOwner = signedIn?.user.id ? `user:${signedIn.user.id}` : null;
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
  const { restore } = useDocumentRestore();
  /**
   * Deleted on main: a success toast naming it, with Undo (restore the
   * version just deleted as a new revision), then the KB's documents.
   */
  const onDeleted = (from: EditingTarget, undo: { revision: string; head: string } | null) => {
    const at = latestDocumentAt(router, from.kbId);
    const latest = at && targetOf(from.kbId, at.search);
    if (undo)
      toast.success(t("document.deletedToast", { path: from.path }), {
        duration: 10_000,
        action: {
          label: t("document.undo"),
          onClick: () =>
            void restore({
              kbId: from.kbId,
              path: from.path,
              revision: undo.revision,
              current: { exists: false, head: undo.head },
            }).then((outcome) => {
              if (outcome?.kind === "applied" || outcome?.kind === "noop")
                toast.success(t("restore.restored", { path: from.path }), {
                  action: {
                    label: t("restore.open"),
                    onClick: () =>
                      void navigate({
                        to: "/$lang/kbs/$kbId/documents",
                        params: { lang, kbId: from.kbId },
                        search: { path: from.path },
                      }),
                  },
                });
              else if (outcome) toast.error(t("restore.undoFailed", { path: from.path }));
            }),
        },
      });
    if (!latest || editingTargetKey(latest) !== editingTargetKey(from)) return;
    void navigate({ to: "/$lang/kbs/$kbId", params: { lang: at.lang, kbId: from.kbId } });
  };
  // A target shown without an editor (a final state, or a failed read with no
  // session): the workspace offers Discard / Cancel only for a kept draft.
  useWorkspaceNoEditor(
    target &&
      !live &&
      target.path !== "" &&
      (terminal || documentRead.isError || absence !== null || proposalRead.isError)
      ? target.target.kind === "proposal"
        ? { path: target.path, proposal: target.target.number }
        : target.target.rev
          ? { path: target.path, rev: target.target.rev }
          : { path: target.path }
      : null,
  );
  if (!kbData) return null;
  const kb = kbData.kb;
  if (search.pr !== undefined && search.path) {
    const path = search.path;
    return (
      <div className="min-w-0 space-y-6">
        <DocumentHeader
          title={documentTitle(null, path)}
          breadcrumb={path}
          meta={<StatusPill tone="busy">{t("prMode.pill", { number: search.pr })}</StatusPill>}
        />
        <KbProposalDocumentEditor
          key={`${kbId}:${path}#${search.pr}`}
          lang={lang}
          kb={kb}
          number={search.pr}
          path={path}
          draftOwner={draftOwner}
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
  // Main's head has no such document: when main deleted it, say so and offer
  // its last version back (with or without a draft open). An older revision
  // that lacks the path is only "not at this revision".
  const atMainHead =
    target.target.kind === "main" &&
    (target.target.rev === null || target.target.rev === kb.headSha);
  const editMode = kbControls(kb.capabilities).editMode;
  const missingNotice = atMainHead ? (
    <DeletedDocumentNotice
      lang={lang}
      kbId={kbId}
      kbHeadSha={kb.headSha}
      canRestore={editMode !== "none"}
      proposing={editMode === "proposal"}
      path={target.path}
      onRestored={(outcome) =>
        goTo(
          outcome.kind === "proposed"
            ? { path: target.path, proposal: outcome.proposalNumber }
            : { path: target.path },
        )
      }
    />
  ) : (
    <p role="status" className="rounded-md border p-4 text-sm">
      {t("document.notFound")}
    </p>
  );
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
    if (missingDocument)
      return (
        <div className="min-w-0 space-y-6">
          <DocumentHeader title={documentTitle(null, target.path)} breadcrumb={target.path} />
          {missingNotice}
          <DocumentHistory lang={lang} kbId={kbId} path={target.path} />
        </div>
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
      {missingDocument && missingNotice}
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
        draftOwner={draftOwner}
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
  draftOwner,
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
  onDeleted: (from: EditingTarget, undo: { revision: string; head: string } | null) => void;
  /** The signed-in person's actor key: drafts are theirs only (null: none kept). */
  draftOwner: string | null;
}) {
  const { t } = useTranslation("kb");
  const kbId = target.kbId;
  const proposal = target.target.kind === "proposal" ? target.target : null;
  // A new draft ("New document") until its create receipt moves the target.
  const draft = target.path === "";
  const userId = draftOwner;
  // Unsaved work kept in this tab for this target (pinned revisions are
  // read-only: nothing to keep). Read once, as the session opens.
  const keyOf = (of: EditingTarget) =>
    userId === null || (of.target.kind === "main" && of.target.rev !== null)
      ? null
      : draftKey({
          userId,
          kbId: of.kbId,
          path: of.path,
          proposal: of.target.kind === "proposal" ? of.target.number : null,
        });
  const [recovered] = useState<StoredDraft | null>(() => {
    const key = keyOf(target);
    const stored = key ? readDraft(key) : null;
    // A new draft is unsaved with only its path typed, too.
    const unsaved =
      stored !== null &&
      (stored.markdown !== (document?.markdown ?? "") || (draft && (stored.path ?? "") !== ""));
    return unsaved ? stored : null;
  });
  const editor = useKbEditor({
    target,
    // A session mounts only with a matching successful read, or as a new
    // draft on the KB head. Later read failures do not reinitialize this
    // hook or replace its live draft.
    initialMarkdown: document?.markdown ?? "",
    // A recovered draft writes against the head it was written on.
    baseRevision: recovered?.base ?? document?.commitSha ?? kb.headSha ?? "",
    recovered: recovered
      ? {
          markdown: recovered.markdown,
          images: recovered.images ?? [],
          ...(draft ? { path: recovered.path ?? "" } : {}),
        }
      : undefined,
    initialExists: !draft,
    onTargetAdvance: onAdvance,
  });
  // A workspace Discard is final for this session: it keeps no draft after it
  // (the keeper drops the stored one as its key goes), even if the session
  // can't turn clean (an unresolved first save holding a typed path).
  const [discarded, setDiscarded] = useState(false);
  // A session that stays open after a Discard (a tree Rename/Delete of this
  // file, then Cancel) keeps new edits again once it is back to clean.
  if (discarded && !editor.dirty && !editor.pending) setDiscarded(false);
  const kept = useDocumentDraft({
    key: discarded ? null : keyOf(target),
    dirty: editor.dirty,
    pending: editor.pending,
    markdown: editor.markdown,
    base: editor.baseRevision,
    path: draft ? editor.path : undefined,
    images: editor.stagedImages,
    pendingUpload: editor.pendingUpload,
  });
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // The move sheet, with the target the workspace tree typed in (rename, drag).
  const [moving, setMoving] = useState<false | { toPath?: string }>(false);
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
  // An older main revision can be written back as the newest one.
  // An older revision opened from before a rename: the document's name now.
  const currentPath = search.rev && search.restoreTo ? search.restoreTo : target.path;
  const canRestore =
    pinned !== null && kb.headSha !== null && controls.editMode !== "none" && !proposal;
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
  const canDelete = writable && !absence && !draft;
  // The workspace (tabs, ⌘S, "close tab", `E`) acts on this session through
  // its registration; its Save is the editor's own (same checks as the button).
  const saveHandle = useRef<EditorSaveHandle>(null);
  // With the edit view hidden (`E`) the draft is still the session's: reopen
  // the editor and save with its own Save (path, uploads, outcomes in view).
  const saveHidden = async () => {
    // An upload still in flight belongs to the editor's own Save (its guard).
    if (editor.pendingUpload) return false;
    goTo({ ...at, mode: "edit" }, true);
    const handle = await nextFrames(() => saveHandle.current, 120);
    return handle ? handle.save() : false;
  };
  const draftKeyNow = keyOf(target);
  useWorkspaceEditorRegistration({
    kbId,
    owner: userId,
    tab: draft
      ? { path: "" }
      : target.target.kind === "proposal"
        ? { path: target.path, proposal: target.target.number }
        : target.target.rev
          ? { path: target.path, rev: target.target.rev }
          : { path: target.path },
    dirty: editor.dirty,
    canEdit: writable && !gone && !draft,
    canSave: writable && !gone && !editor.pendingUpload,
    pending: editor.pending,
    uploading: editor.pendingUpload !== null,
    keepDraft: kept.keepNow,
    save: async () =>
      editor.pendingUpload
        ? false
        : saveHandle.current
          ? saveHandle.current.save()
          : draft
            ? false
            : saveHidden(),
    discard: () => {
      editor.discard();
      setDiscarded(true);
      // Gone now, not only once the keeper next runs: the tab closes at once.
      if (draftKeyNow) clearDraft(draftKeyNow);
    },
  });
  // The workspace tree's Rename, drag-to-move and Delete of this document run
  // here, through this session's own sheet and confirmation.
  // Never over unsaved edits (the workspace settles them first; a draft
  // restored here meanwhile keeps the request from running).
  const fileOpsReady =
    canDelete && !editor.pending && !editor.dirty && !gone && target.target.kind === "main";
  useWorkspaceFileRequest({
    owner: userId,
    kbId,
    kind: "move",
    ready: fileOpsReady,
    accepts: (request) => request.path === target.path,
    apply: (request) => {
      setDeleting(false);
      setMoving({ toPath: request.toPath });
    },
  });
  useWorkspaceFileRequest({
    owner: userId,
    kbId,
    kind: "delete",
    ready: fileOpsReady,
    accepts: (request) => request.path === target.path,
    apply: () => {
      setMoving(false);
      setDeleting(true);
    },
  });
  // Secondary and destructive actions live in one "More actions" menu.
  const moreActions: MoreAction[] = canDelete
    ? [
        documentMoveAction(t, editor.pending, () => setMoving({})),
        {
          key: "delete",
          label: t("editor.delete"),
          destructive: true,
          disabled: editor.pending,
          testId: "document-delete",
          onSelect: () => setDeleting(true),
        },
      ]
    : [];
  const doneEditing = (
    <Link
      to="/$lang/kbs/$kbId/documents"
      params={{ lang, kbId }}
      search={at}
      className={cn(buttonVariants({ variant: "outline", size: "touch" }))}
    >
      {t("document.doneEditing")}
    </Link>
  );

  return (
    <div className="min-w-0 space-y-6">
      <DocumentHeader
        // The document's own title (its H1), with the path as a quiet breadcrumb.
        title={
          draft ? t("detail.newDocument") : documentTitle(document?.markdown ?? null, target.path)
        }
        breadcrumb={draft ? undefined : target.path}
        meta={
          !draft && (
            <>
              {pinned ? (
                <StatusPill tone="busy" title={t("document.revision", { sha: short(pinned) })}>
                  {t("document.olderRevision")}
                </StatusPill>
              ) : (
                !proposal &&
                document && (
                  <LastSaved lang={lang} kbId={kbId} path={target.path} rev={document.commitSha} />
                )
              )}
              {document && <ProvenanceBadge provenance={document.provenance} />}
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
          // While editing, every action is in the editor's own bar; a
          // read-only edit view (older revision, closed proposal) has none.
          !draft &&
          !gone &&
          (editing ? (
            !writable && doneEditing
          ) : (
            <>
              {writable && (
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
              )}
              {document && <DownloadDialog kbId={kbId} rev={document.commitSha} />}
              <DocumentMoreMenu actions={moreActions} />
            </>
          ))
        }
      />
      {canDelete && moving && (
        <DocumentMoveSheet
          editor={editor}
          proposing={controls.editMode === "proposal" || editor.proposal}
          initialToPath={moving.toPath}
          onOpenChange={(open) => setMoving(open ? moving : false)}
        />
      )}
      {canDelete && (
        <KbDocumentDelete
          lang={lang}
          kbId={kbId}
          editor={editor}
          proposing={controls.editMode === "proposal"}
          open={deleting}
          onOpenChange={setDeleting}
          onDeleted={(undo) => onDeleted(target, undo)}
        />
      )}
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
          <p>
            {t(canRestore ? "editor.oldRevisionRestore" : "editor.oldRevision", {
              sha: short(pinned),
            })}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {canRestore && (
              <Button
                data-testid="document-restore"
                className="min-h-[44px]"
                onClick={() => setRestoring(true)}
              >
                {controls.editMode === "proposal"
                  ? t("restore.proposeThis")
                  : t("restore.restoreThis")}
              </Button>
            )}
            <Button
              variant="outline"
              className="min-h-[44px]"
              onClick={() => goTo({ path: currentPath })}
            >
              {t("editor.openLatest")}
            </Button>
          </div>
          {canRestore && kb.headSha && (
            <RestoreVersionDialog
              lang={lang}
              kbId={kbId}
              kbHeadSha={kb.headSha}
              proposing={controls.editMode === "proposal"}
              path={currentPath}
              sourcePath={target.path}
              revision={pinned}
              open={restoring}
              onOpenChange={setRestoring}
              onRestored={(outcome) => {
                setRestoring(false);
                goTo(
                  outcome.kind === "proposed"
                    ? { path: currentPath, proposal: outcome.proposalNumber }
                    : { path: currentPath },
                );
              }}
            />
          )}
        </div>
      )}
      {editor.dirty && (recovered || !editing) && (
        <div
          role="status"
          data-testid="document-draft-notice"
          className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          <p>
            {recovered
              ? t("draft.recovered", {
                  time: new Date(recovered.savedAt).toLocaleTimeString(lang, {
                    hour: "numeric",
                    minute: "2-digit",
                  }),
                })
              : t("draft.unsaved")}
          </p>
          {!editing && writable && (
            <Link
              to="/$lang/kbs/$kbId/documents"
              params={{ lang, kbId }}
              search={{ ...at, mode: "edit" }}
              className={buttonVariants({ size: "touch" })}
            >
              {t("draft.continue")}
            </Link>
          )}
        </div>
      )}
      {gone ? null : editing ? (
        <KbSessionEditor
          lang={lang}
          kb={kb}
          isNew={draft}
          editor={editor}
          fileRequestOwner={userId}
          closed={!open}
          viewingRevision={pinned}
          // Media resolve at the revision the document was read at, with that
          // read's own manifest (a recovered draft's base may be older).
          preview={
            document
              ? { rev: document.commitSha, assets: document.assetRefs }
              : { rev: editor.baseRevision, assets: [] }
          }
          onOpenLatest={(path) => goTo({ path, mode: "edit" })}
          onProposed={(number, created) => void onProposed(number, created)}
          saveRef={saveHandle}
          doneAction={draft ? undefined : doneEditing}
          moreActions={moreActions}
        />
      ) : document ? (
        // Rendered at the commit the document was read at, so media stay pinned to it.
        <KbRenderedDocument lang={lang} kbId={kbId} document={document} showRevision={false} />
      ) : null}
      {!draft && !editing && !proposal && (
        // The document's history under its name now, also while an older
        // revision is open at the name it had then (its rows keep `restoreTo`).
        <DocumentHistory lang={lang} kbId={kbId} path={currentPath} />
      )}
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
 * The viewer's own open pull request already changes this document:
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
  const { data: proposal, error } = useQuery(
    orpc.pullRequests.forDocument.queryOptions({ input: { kbId, path }, retry: false }),
  );
  // A denial here rechecks the KB like the page's other reads.
  useKbAccessLoss(kbId, [error]);
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
  breadcrumb,
  meta,
  actions,
}: {
  title: string;
  /** The document's path, shown quietly above its title. */
  breadcrumb?: string;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
      <header className="min-w-0 space-y-1.5">
        {breadcrumb && (
          <p
            data-testid="document-breadcrumb"
            className="truncate font-mono text-xs text-muted-foreground"
          >
            {breadcrumb}
          </p>
        )}
        <h1 className="text-lg font-semibold break-words sm:text-xl">{title}</h1>
        {meta && <div className="flex flex-wrap items-center gap-2">{meta}</div>}
      </header>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

/**
 * "Last saved 5 minutes ago by Ana in the web app": the document's latest
 * change on main, from its history (the same query as the History list).
 * The revision id stays one hover away and in History.
 */
function LastSaved({
  lang,
  kbId,
  path,
  rev,
}: {
  lang: string;
  kbId: string;
  path: string;
  rev: string;
}) {
  const { t } = useTranslation("kb");
  const { data, error } = useInfiniteQuery(documentHistoryOptions(kbId, path));
  const latest = visibleHistoryRows(data?.pages, error !== null)[0];
  if (!latest || latest.committedAt === null) return null;
  const at = Date.parse(latest.committedAt);
  const when = formatRelativeTime(at, lang);
  return (
    <span
      data-testid="document-last-saved"
      data-revision={latest.sha}
      title={t("document.lastSavedTitle", {
        date: new Date(at).toLocaleString(lang),
        sha: short(latest.sha),
        rev: short(rev),
      })}
      className="text-sm text-muted-foreground"
    >
      {latest.actor.kind === "unattributed"
        ? t("document.lastSavedUnattributed", { when })
        : t("document.lastSaved", { when, actor: actorLine(t, latest.actor) })}
    </span>
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
          <KbDownloads kbId={kbId} rev={rev} origin={env.VITE_SERVER_URL} />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Polls `read` once per animation frame until it yields, at most `frames` times. */
function nextFrames<T>(read: () => T | null, frames: number): Promise<T | null> {
  return new Promise((resolve) => {
    let left = frames;
    const tick = () => {
      const value = read();
      if (value !== null || left-- <= 0) resolve(value);
      else requestAnimationFrame(tick);
    };
    tick();
  });
}
