import { Button } from "@knowledge-base/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@knowledge-base/ui/components/sheet";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { cn } from "@knowledge-base/ui/lib/utils";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Bot,
  ChevronLeft,
  FolderTree,
  Keyboard,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { InlineRetry } from "@/components/inline-retry";
import { DirtyCloseDialog } from "@/components/kb/workspace/dirty-close-dialog";
import { DocumentReference } from "@/components/kb/workspace/document-reference";
import { FileTree } from "@/components/kb/workspace/file-tree";
import { OutlinePanel } from "@/components/kb/workspace/outline-panel";
import { QuickOpen } from "@/components/kb/workspace/quick-open";
import { RecentChangesPanel } from "@/components/kb/workspace/recent-changes-panel";
import { ResizeHandle } from "@/components/kb/workspace/resize-handle";
import { ShortcutsSheet } from "@/components/kb/workspace/shortcuts-sheet";
import { SidebarSearch } from "@/components/kb/workspace/sidebar-search";
import { TabStrip, TabSwitcher } from "@/components/kb/workspace/tab-strip";
import { useTreeFileOps } from "@/components/kb/workspace/tree-file-ops";
import { WorkspaceSidebar } from "@/components/kb/workspace/workspace-sidebar";
import { clearDraft, draftKey, readDraft } from "@/hooks/use-document-draft";
import { useKbHeadSha } from "@/hooks/use-kb-head-sha";
import { useKbRecentChanges } from "@/hooks/use-kb-recent-changes";
import { useKbTree } from "@/hooks/use-kb-tree";
import { useKbWorkspaceTabs } from "@/hooks/use-kb-workspace-tabs";
import { useMainScrollerHeight } from "@/hooks/use-main-scroller-height";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useMountEffect } from "@/hooks/use-mount-effect";
import { useResolvePendingClose } from "@/hooks/use-resolve-pending-close";
import { useSaveWhenReady } from "@/hooks/use-save-when-ready";
import { useWorkspaceShortcuts } from "@/hooks/use-workspace-shortcuts";
import { agentBadges } from "@/lib/kb-workspace/agent-activity";
import { isMacPlatform } from "@/lib/kb-workspace/shortcuts";
import { retargetApplies, tabKey, type WorkspaceTab } from "@/lib/kb-workspace/tabs";
import {
  useKbWorkspaceLayout,
  useKbWorkspaceStore,
  type WorkspaceFileRequest,
} from "@/stores/kb-workspace";
import { orpc } from "@/utils/orpc";
import { formatRelativeTime } from "@/utils/relative-time";

/** The workspace's tree + tabs layout needs this much width; below it, one pane at a time. */
const WORKSPACE_WIDE_QUERY = "(min-width: 1024px)";

/** The document route's search, as far as the workspace names files by it. */
export type WorkspaceSearch = {
  path?: string;
  rev?: string;
  proposal?: number;
  pr?: number;
  mode?: "new" | "edit";
};

/**
 * Pure: which file's unsaved edits a tree file operation asks about first
 * (its tab key), or null to go ahead. Even where a draft could be kept, a move
 * or delete leaves none behind: the open editor's edits, then the target
 * file's kept draft. A file already answered (`settled`) is not asked again: a
 * Discard is final even where the session can't turn clean (an unresolved
 * first save keeps its path).
 */
export function fileOpQuestion({
  live,
  target,
  kind,
  settled,
}: {
  live: { key: string; dirty: boolean; uploading: boolean } | null;
  target: { key: string; hasDraft: boolean } | null;
  kind: "move" | "delete" | "new";
  settled: readonly string[];
}): string | null {
  if (live && (live.dirty || live.uploading) && !settled.includes(live.key)) return live.key;
  if (kind === "new" || !target || target.key === live?.key) return null;
  return target.hasDraft && !settled.includes(target.key) ? target.key : null;
}

/** The tab a document URL shows (null: no file, e.g. the KB home). */
export function tabOfSearch(search: WorkspaceSearch | null): WorkspaceTab | null {
  if (!search) return null;
  if (search.mode === "new") return { path: "" };
  // No path and no `mode=new`: no file (also a navigation still on its way out).
  if (!search.path) return null;
  return {
    path: search.path,
    ...(search.pr !== undefined
      ? { pr: search.pr }
      : search.proposal !== undefined
        ? { proposal: search.proposal }
        : search.rev
          ? { rev: search.rev }
          : {}),
    ...(search.mode === "edit" ? { mode: "edit" as const } : {}),
  };
}

/** The document URL that shows a tab (in the mode it was last shown in). */
export function searchOfTab(tab: WorkspaceTab): WorkspaceSearch {
  if (tab.path === "") return { mode: "new" };
  return {
    path: tab.path,
    ...(tab.pr !== undefined
      ? { pr: tab.pr, mode: "edit" as const }
      : {
          ...(tab.proposal !== undefined ? { proposal: tab.proposal } : {}),
          ...(tab.rev ? { rev: tab.rev } : {}),
          ...(tab.mode === "edit" ? { mode: "edit" as const } : {}),
        }),
  };
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Where a tab's unsaved draft is kept (the session's own draft key): PR mode
 * keeps its own; a pinned version keeps none; no viewer, nothing.
 */
export function tabDraftKey(owner: string | null, kbId: string, tab: WorkspaceTab): string | null {
  if (owner === null || tab.rev !== undefined) return null;
  return draftKey(
    tab.pr !== undefined
      ? { userId: owner, kbId, path: tab.path, proposal: tab.pr, resolving: true }
      : { userId: owner, kbId, path: tab.path, proposal: tab.proposal ?? null },
  );
}

/** A leave waiting for an answer about one file's unsaved edits. */
type Pending = {
  key: string;
  /** This question's identity (its file's key may move: a New document's first save). */
  id: number;
  intent: LeaveIntent;
  /** Save was chosen for a file whose editor wasn't open: it is opened and saved when ready. */
  saveWhenReady?: boolean;
  /** Files already answered in this operation (a tree file op): not asked about again. */
  settled?: readonly string[];
};

/**
 * Pure: whether leaving the open editor asks first. An upload in flight always
 * waits; unsaved edits ask unless their draft is kept here, or the person
 * already answered for that file in this same operation (`settled`: a Discard
 * stays final even where the session can't turn clean).
 */
export function leaveAsks(
  editor: { key: string; dirty: boolean; uploading: boolean; keepDraft: () => boolean } | null,
  settled: readonly string[] = [],
): boolean {
  if (!editor) return false;
  if (editor.uploading) return true;
  return editor.dirty && !settled.includes(editor.key) && !editor.keepDraft();
}

/** What leaving a file was for, carried out once its unsaved edits are settled. */
type LeaveIntent =
  | { kind: "close"; key: string }
  | { kind: "go"; tab: WorkspaceTab | null }
  | { kind: "run"; run: () => void };

/**
 * The KB workspace: the file tree on the left (resizable, hideable), the
 * open files as tabs, and the document (read view, or read + edit) on the
 * right. The URL names the file and mode; the strip is the viewer's own.
 * Below `WORKSPACE_WIDE_QUERY` there is no strip: the tree is a drawer and
 * open files are a "Recent files" switcher.
 */
export function KbWorkspace({
  lang,
  kbId,
  kbName,
  viewerId,
  canRead,
  canWrite,
  current,
  children,
}: {
  lang: string;
  /** The signed-in viewer (route context), null while unknown: nothing is remembered then. */
  viewerId: string | null;
  kbId: string;
  kbName: string;
  canRead: boolean;
  /** The viewer may write or propose: the tree offers its file operations. */
  canWrite: boolean;
  /** The document URL's search, or null on the KB home. */
  current: WorkspaceSearch | null;
  children: ReactNode;
}) {
  const { t, i18n } = useTranslation("kb");
  const navigate = useNavigate();
  const wide = useMediaQuery(WORKSPACE_WIDE_QUERY);
  const paneHeight = useMainScrollerHeight();
  // The viewer the protected layout resolved (its tabs, its recent KBs, its drafts).
  const userId = viewerId;
  const draftOwner = viewerId ? `user:${viewerId}` : null;
  const editor = useKbWorkspaceStore((state) => state.editor);
  const layout = useKbWorkspaceLayout();
  const tree = useKbTree(kbId, canRead, viewerId);
  const head = useKbHeadSha(kbId);
  const currentTab = tabOfSearch(current);
  // Unsaved: the open editor says so, or a tab left with edits kept its draft
  // in this browser tab (kb-recovery's draft keeping; PR mode keeps its own);
  // pinned versions keep none.
  const hasDraft = (tab: WorkspaceTab) => {
    const key = tabDraftKey(draftOwner, kbId, tab);
    return key !== null && readDraft(key) !== null;
  };
  const isDirtyTab = (tab: WorkspaceTab) =>
    editor?.key === tabKey(tab) ? editor.dirty : hasDraft(tab);
  const tabs = useKbWorkspaceTabs({ userId, kbId, current: currentTab, isDirtyTab });
  const isDirty = (key: string) => {
    const tab = tabs.state.tabs.find((open) => tabKey(open) === key);
    return tab ? isDirtyTab(tab) : editor?.key === key && editor.dirty;
  };
  const [quickOpen, setQuickOpen] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [drawer, setDrawer] = useState(false);
  // Leaving a file with unsaved edits waits for Save / Discard / Cancel: closing
  // its tab, phone Back, or switching away when its draft can't be kept here.
  // The intent is resolved against the strip as it is when answered.
  const [pending, setPending] = useState<Pending | null>(null);
  // A file's session moved (a New document's first save): the question follows it.
  const retarget = useKbWorkspaceStore((state) => state.retarget);
  const [seenRetarget, setSeenRetarget] = useState(
    () => useKbWorkspaceStore.getState().retarget?.id ?? 0,
  );
  if (retarget && retarget.id > seenRetarget) {
    setSeenRetarget(retarget.id);
    if (
      pending &&
      retargetApplies(retarget, seenRetarget, kbId, draftOwner) &&
      pending.key === retarget.from
    ) {
      const to = tabKey(retarget.to);
      setPending({
        ...pending,
        key: to,
        intent:
          pending.intent.kind === "close" && pending.intent.key === retarget.from
            ? { kind: "close", key: to }
            : pending.intent,
      });
    }
  }
  const questions = useRef(0);
  const nextQuestion = () => ++questions.current;
  const [mac] = useState(isMacPlatform);
  const panelId = useId();
  const contentRef = useRef<HTMLDivElement>(null);

  const go = (tab: WorkspaceTab | null) => {
    if (!tab) {
      void navigate({ to: "/$lang/kbs/$kbId", params: { lang, kbId } });
      return;
    }
    void navigate({
      to: "/$lang/kbs/$kbId/documents",
      params: { lang, kbId },
      search: searchOfTab(tab),
    });
  };
  const tabOf = (key: string) => tabs.state.tabs.find((tab) => tabKey(tab) === key) ?? null;
  /** Keyboard focus never falls to the page when its tab goes: the strip keeps it. */
  const refocusStrip = () =>
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    });
  /** Carry out an intent now, against the current strip. */
  const perform = (intent: LeaveIntent) => {
    switch (intent.kind) {
      case "close": {
        const wasActive = tabs.activeKey === intent.key;
        const next = tabs.close(intent.key);
        if (wasActive) go(next);
        refocusStrip();
        return;
      }
      case "go":
        go(intent.tab);
        return;
      case "run":
        intent.run();
        return;
    }
  };
  /**
   * Leave the open file for something else. Its unsaved draft is normally kept
   * in this browser tab (it reopens dirty); when it really wasn't kept (storage
   * blocked or full, too large), ask Save / Discard / Cancel first.
   */
  const leave = (intent: LeaveIntent, settled: readonly string[] = []) => {
    // An image still uploading lives in this editor's session only: wait for it.
    if (editor && leaveAsks(editor, settled))
      setPending({ key: editor.key, intent, id: nextQuestion() });
    else perform(intent);
  };
  const show = (tab: WorkspaceTab | null) => {
    if (tab && editor && tabKey(tab) === editor.key) return;
    leave({ kind: "go", tab });
  };
  /**
   * Open a file on main (its open tab, in the mode it was left in), optionally
   * at a heading; `background` adds its tab without leaving the current file.
   */
  const openPath = (path: string, hash?: string, background = false, keepFocus = false) => {
    if (background) {
      tabs.openInBackground({ path });
      return;
    }
    const open = tabs.state.tabs.find((tab) => tabKey(tab) === tabKey({ path }));
    setDrawer(false);
    const search = searchOfTab(open ?? { path });
    const run = () =>
      void navigate({
        to: "/$lang/kbs/$kbId/documents",
        params: { lang, kbId },
        // A heading lives in the read view (the editor's preview has its own ids);
        // the file's draft stays its session's.
        search: hash ? { ...search, mode: undefined } : search,
        ...(hash ? { hash } : {}),
      }).then(() => {
        // The chosen file has the focus (a heading jump keeps its own scroll),
        // except a file opened with Enter in the tree: browsing goes on there.
        if (!keepFocus) contentRef.current?.focus({ preventScroll: true });
      });
    if (editor && editor.key === tabKey({ path })) run();
    else leave({ kind: "run", run });
  };
  /**
   * A tree file operation: open its file (asking about unsaved work first, as
   * any switch does) and hand the page the request it carries out with its
   * own session. Nothing is written here.
   */
  const requestFile = useKbWorkspaceStore((state) => state.requestFile);
  // A request this workspace left behind never outlives it (another account,
  // another KB, leaving the workspace).
  const clearFileRequest = useKbWorkspaceStore((state) => state.clearFileRequest);
  useMountEffect(() => clearFileRequest);
  const startFileOp = (
    tab: WorkspaceTab,
    request: WorkspaceFileRequest,
    settled: readonly string[] = [],
  ) => {
    if (draftOwner === null) return;
    const owner = draftOwner;
    setDrawer(false);
    const open = tabs.state.tabs.find((other) => tabKey(other) === tabKey(tab));
    // Unsaved edits are settled first (Save / Discard / Cancel); each answer
    // starts the operation over against the state as it is then, never asking
    // about an answered file again.
    const ask = fileOpQuestion({
      live: useKbWorkspaceStore.getState().editor,
      target: open ? { key: tabKey(open), hasDraft: hasDraft(open) } : null,
      kind: request.kind,
      settled,
    });
    if (ask !== null) {
      const again = () => startFileOp(tab, request, [...settled, ask]);
      setPending({ key: ask, intent: { kind: "run", run: again }, id: nextQuestion(), settled });
      return;
    }
    const run = () => {
      requestFile(owner, kbId, request);
      void navigate({
        to: "/$lang/kbs/$kbId/documents",
        params: { lang, kbId },
        search: searchOfTab(open ?? tab),
      });
    };
    run();
  };
  const fileOps = useTreeFileOps({
    canWrite,
    paths: tree.paths,
    start: startFileOp,
    newBusy: () => isDirtyTab({ path: "" }),
  });
  /**
   * A search hit opens at the version it was cited at, as the KB page's search
   * does: on main when that is the head, else that pinned version (its heading
   * and passage are there).
   */
  const openHit = (path: string, hash: string | undefined, rev: string) => {
    if (rev === head) {
      openPath(path, hash);
      return;
    }
    setDrawer(false);
    leave({
      kind: "run",
      run: () =>
        void navigate({
          to: "/$lang/kbs/$kbId/documents",
          params: { lang, kbId },
          search: { path, rev },
          ...(hash ? { hash } : {}),
        }).then(() => contentRef.current?.focus({ preventScroll: true })),
    });
  };
  const finish = () => {
    const intent = pending?.intent;
    setPending(null);
    if (intent) perform(intent);
  };
  /**
   * Close a tab, or leave the open file (phone Back); unsaved edits ask first.
   * Save / Discard act on the file's own editor, so another tab is shown first,
   * leaving the current one by the same rules.
   */
  /**
   * Close a tab, or leave the open file (phone Back); unsaved edits ask first.
   * The open file is asked about with its editor. Another tab's kept draft is
   * asked about where it is: Discard drops it, Cancel keeps it, and only Save
   * opens it (leaving the current file by the same rules) and saves it there.
   */
  const request = (key: string, then: LeaveIntent) => {
    if (!isDirty(key)) perform(then);
    else setPending({ key, intent: then, id: nextQuestion() });
  };
  /** Save chosen for a file whose editor isn't open: open it, save when it's ready. */
  const openToSave = (question: Pending) =>
    leave(
      {
        kind: "run",
        run: () => {
          go(tabOf(question.key));
          setPending({ ...question, saveWhenReady: true });
        },
      },
      question.settled,
    );
  const requestClose = (key: string) => request(key, { kind: "close", key });
  const pendingTab = pending ? tabOf(pending.key) : null;
  const pendingEditor = pending && editor?.key === pending.key ? editor : null;
  // Its file is shown without an editor (gone, PR closed): only Discard / Cancel.
  const noEditor = useKbWorkspaceStore((state) => state.noEditor);
  const orphaned = pending !== null && pendingEditor === null && noEditor === pending.key;
  useSaveWhenReady(pending, pendingEditor, orphaned, {
    unsavable: () => setPending((p) => (p ? { ...p, saveWhenReady: false } : p)),
    nothing: () => setPending(null),
    failed: (id) => {
      setPending((p) => (p?.id === id ? null : p));
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>('[data-testid="editor-save"]')?.focus(),
      );
    },
  });
  useResolvePendingClose(pending, editor, finish);

  const toggleEdit = () => {
    if (!current?.path || current.pr !== undefined || current.mode === "new") return false;
    if (current.mode !== "edit" && !editor?.canEdit) return false;
    // An image still uploading lives in the open editor: it stays open until done.
    if (current.mode === "edit" && editor?.uploading) return true;
    void navigate({
      to: "/$lang/kbs/$kbId/documents",
      params: { lang, kbId },
      search: { ...current, mode: current.mode === "edit" ? undefined : "edit" },
      replace: true,
      resetScroll: false,
    });
    return true;
  };
  useWorkspaceShortcuts({
    // Inside the workspace ⌘S never opens the browser's "Save page" dialog.
    save: () => {
      if (editor?.canSave && editor.dirty) void editor.save();
      return true;
    },
    closeTab: () => {
      if (!tabs.activeKey) return false;
      requestClose(tabs.activeKey);
      return true;
    },
    nextTab: () => {
      const next = tabs.cycle(1);
      if (!next) return false;
      show(next);
      return true;
    },
    prevTab: () => {
      const next = tabs.cycle(-1);
      if (!next) return false;
      show(next);
      return true;
    },
    quickOpen: () => {
      if (!canRead) return false;
      setQuickOpen(true);
      return true;
    },
    toggleEdit,
    shortcuts: () => {
      setShortcuts(true);
      return true;
    },
    // `/`: the sidebar's search, focused (the drawer opens on narrow widths).
    search: () => {
      if (!canRead) return false;
      layout.setSidebarView("search");
      if (wide) layout.setTreeOpen(true);
      else setDrawer(true);
      requestAnimationFrame(() => {
        const inputs = document.querySelectorAll<HTMLInputElement>("[data-workspace-search-input]");
        // The visible one (a closing drawer may still hold another).
        for (const input of inputs) {
          if (input.offsetParent !== null) {
            input.focus();
            input.select();
            return;
          }
        }
      });
      return true;
    },
    toggleTree: () => {
      if (wide) layout.setTreeOpen(!layout.treeOpen);
      else setDrawer((open) => !open);
      return true;
    },
  });

  const activePath = currentTab && currentTab.path !== "" ? currentTab.path : null;
  // The outline reads the document the page shows (the same query, so no second read);
  // a proposal's or PR's version is resolved by the page, so it has none here.
  const outlineInput =
    activePath && currentTab && currentTab.proposal === undefined && currentTab.pr === undefined
      ? { kbId, path: activePath, ...(currentTab.rev ? { rev: currentTab.rev } : {}) }
      : null;
  const { data: outlineDocument } = useQuery({
    ...orpc.documents.get.queryOptions({ input: outlineInput ?? skipToken }),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const outlineMarkdown = outlineInput ? (outlineDocument?.markdown ?? null) : undefined;
  // Documents an agent changed lately carry a badge in the tree (same read as Activity).
  const recent = useKbRecentChanges(kbId, canRead, viewerId);
  const badges = useMemo(() => {
    const now = Date.now();
    const out = new Map<string, ReactNode>();
    for (const [path, change] of agentBadges(recent.items, now)) {
      const when = formatRelativeTime(Date.parse(change.at), i18n.language, now);
      out.set(
        path,
        <Bot
          role="img"
          aria-label={t("workspace.activity.badge", { when })}
          className="size-3.5 shrink-0 text-sky-600 dark:text-sky-400"
        />,
      );
    }
    return out;
  }, [recent.items, i18n.language, t]);
  const stripTabs = tabs.state.tabs.map((tab) => {
    const key = tabKey(tab);
    const name = tab.path === "" ? t("detail.newDocument") : basename(tab.path);
    const variant =
      tab.pr !== undefined
        ? t("workspace.shell.tabVariant.pr", { number: tab.pr })
        : tab.proposal !== undefined
          ? t("workspace.shell.tabVariant.proposal", { number: tab.proposal })
          : tab.rev
            ? t("workspace.shell.tabVariant.revision", { sha: tab.rev.slice(0, 7) })
            : null;
    return {
      key,
      label: variant ? `${name} · ${variant}` : name,
      title: tab.path || name,
      dirty: isDirty(key),
    };
  });

  const activeTab = stripTabs.find((tab) => tab.key === tabs.activeKey) ?? null;
  // The tree marks files with unsaved edits on main (their open tab's state).
  const dirtyPaths = new Set(
    tabs.state.tabs
      .filter((tab) => tab.rev === undefined && tab.pr === undefined && tab.proposal === undefined)
      .filter(isDirtyTab)
      .map((tab) => tab.path),
  );
  const treePanel = (
    <WorkspaceSidebarPane
      lang={lang}
      kbId={kbId}
      kbName={kbName}
      viewerId={viewerId}
      tree={tree}
      activePath={activePath}
      outlineMarkdown={outlineMarkdown}
      onOpen={openPath}
      onOpenHit={openHit}
      badges={badges}
      dirtyPaths={dirtyPaths}
      onHide={wide ? () => layout.setTreeOpen(false) : undefined}
      onNavigated={() => setDrawer(false)}
      treeOps={fileOps.treeProps}
      treeToolbar={fileOps.toolbar}
    />
  );

  return (
    <div
      className="flex min-h-full min-w-0"
      style={{ "--kb-pane-h": paneHeight > 0 ? `${paneHeight}px` : "100svh" } as CSSProperties}
      data-testid="kb-workspace"
    >
      {wide && layout.treeOpen && (
        <>
          <aside
            aria-label={t("workspace.tree.label")}
            className="sticky top-0 flex h-(--kb-pane-h) shrink-0 flex-col border-e bg-sidebar/40"
            style={{ width: layout.treeWidth }}
          >
            {treePanel}
          </aside>
          <ResizeHandle
            className="sticky top-0 h-(--kb-pane-h)"
            value={layout.treeWidth}
            min={200}
            max={640}
            defaultValue={280}
            onChange={layout.setTreeWidth}
            label={t("workspace.resize.tree")}
          />
        </>
      )}
      <section className="flex min-w-0 flex-1 flex-col">
        <div
          data-testid="kb-workspace-toolbar"
          className="sticky top-0 z-20 flex min-h-11 items-center gap-1 border-b bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/80"
        >
          {wide ? (
            <>
              {!layout.treeOpen && (
                <Button
                  variant="ghost"
                  size="icon-touch"
                  aria-label={t("workspace.shell.showTree")}
                  title={t("workspace.shell.showTree")}
                  onClick={() => layout.setTreeOpen(true)}
                >
                  <PanelLeftOpen aria-hidden className="size-4" />
                </Button>
              )}
              <div className="min-w-0 flex-1">
                {stripTabs.length > 0 && (
                  <TabStrip
                    tabs={stripTabs}
                    activeKey={tabs.activeKey}
                    onActivate={(key) => show(tabOf(key))}
                    onClose={requestClose}
                    ariaLabel={t("workspace.tabs.label")}
                    panelId={panelId}
                  />
                )}
              </div>
            </>
          ) : (
            <>
              {tabs.activeKey && (
                <Button
                  variant="ghost"
                  size="icon-touch"
                  aria-label={t("workspace.shell.back")}
                  title={t("workspace.shell.back")}
                  onClick={() =>
                    tabs.activeKey && request(tabs.activeKey, { kind: "go", tab: null })
                  }
                >
                  <ChevronLeft aria-hidden className="size-4" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="touch"
                onClick={() => setDrawer(true)}
                aria-haspopup="dialog"
              >
                <FolderTree aria-hidden className="size-4" />
                <span className="max-sm:sr-only">{t("workspace.shell.files")}</span>
              </Button>
              <div className="min-w-0 flex-1">
                <TabSwitcher
                  tabs={stripTabs}
                  activeKey={tabs.activeKey}
                  onActivate={(key) => show(tabOf(key))}
                  onClose={requestClose}
                />
              </div>
            </>
          )}
          {activePath && (
            <DocumentReference
              // The web app's own origin (the API may live elsewhere in development).
              origin={window.location.origin}
              lang={lang}
              kbId={kbId}
              kbName={kbName}
              path={activePath}
            />
          )}
          {canRead && (
            <Button
              variant="ghost"
              size="icon-touch"
              aria-label={t("workspace.quickOpen.title")}
              title={t("workspace.quickOpen.title")}
              onClick={() => setQuickOpen(true)}
            >
              <Search aria-hidden className="size-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-touch"
            className="hidden pointer-fine:inline-flex"
            aria-label={t("workspace.shortcuts.title")}
            title={t("workspace.shortcuts.title")}
            onClick={() => setShortcuts(true)}
          >
            <Keyboard aria-hidden className="size-4" />
          </Button>
        </div>
        <div
          ref={contentRef}
          // Focus lands here when a file is opened from the tree, Go to file or
          // search, as in an editor: `E` and ⌘S then act on it.
          tabIndex={-1}
          className="min-w-0 flex-1 px-4 py-4 outline-none md:px-6 md:py-6"
          {...(wide && activeTab
            ? { id: panelId, role: "tabpanel", "aria-label": activeTab.title }
            : {})}
        >
          {children}
        </div>
      </section>
      {!wide && (
        <Sheet open={drawer} onOpenChange={setDrawer}>
          <SheetContent side="left" className="w-[min(22rem,90vw)] gap-0 p-0">
            <SheetHeader className="border-b">
              <SheetTitle>{kbName}</SheetTitle>
              <SheetDescription className="sr-only">{t("workspace.tree.label")}</SheetDescription>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col">{treePanel}</div>
          </SheetContent>
        </Sheet>
      )}
      <QuickOpen
        open={quickOpen}
        onOpenChange={setQuickOpen}
        paths={tree.paths}
        mac={mac}
        onOpen={(path, options) => {
          setQuickOpen(false);
          openPath(path, undefined, options?.newTab);
        }}
      />
      <ShortcutsSheet open={shortcuts} onOpenChange={setShortcuts} mac={mac} />
      {fileOps.dialogs}
      <DirtyCloseDialog
        // One dialog per question: its own Saving… state never carries over.
        key={pending?.id ?? 0}
        // Stays open while a file being saved opens (busy until it is saved).
        open={pendingTab !== null && (pendingEditor ? pendingEditor.dirty : true)}
        name={pendingTab ? basename(pendingTab.path) || t("detail.newDocument") : ""}
        canSave={pendingEditor ? pendingEditor.canSave : !orphaned}
        busy={
          Boolean(pending?.saveWhenReady) ||
          Boolean(pendingEditor && (pendingEditor.pending || pendingEditor.uploading))
        }
        // Save and Discard only settle the file; once its editor reports it clean
        // (`useResolvePendingClose`) the intent is carried out, exactly once.
        onSave={async () => {
          if (!pending) return false;
          if (!pendingEditor) {
            openToSave(pending);
            return false;
          }
          const question = pending.id;
          const saved = await pendingEditor.save();
          // Not saved (a conflict, a refused path, …): the editor says why; let
          // the person see it there, with focus on its Save and its status.
          // Only this question is dropped (another may have been asked since).
          if (!saved) {
            setPending((p) => (p?.id === question ? null : p));
            requestAnimationFrame(() =>
              document.querySelector<HTMLElement>('[data-testid="editor-save"]')?.focus(),
            );
          }
          return saved;
        }}
        onDiscard={() => {
          if (!pending || !pendingTab) return;
          if (pendingEditor) {
            if (pendingEditor.pending || pendingEditor.uploading) return;
            // Discard is final: the session stops keeping its draft and the leave
            // completes now (not on a clean state an unresolved save may never reach).
            pendingEditor.discard();
            finish();
            return;
          }
          // Its editor isn't open: the kept draft is all there is to drop.
          const key = tabDraftKey(draftOwner, kbId, pendingTab);
          if (key) clearDraft(key);
          finish();
        }}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}

/**
 * The left pane: the KB's name, then Files (the tree), Search (hits jump to
 * their heading) and the open document's Outline.
 */
function WorkspaceSidebarPane({
  lang,
  kbId,
  kbName,
  viewerId,
  tree,
  activePath,
  outlineMarkdown,
  onOpen,
  onOpenHit,
  badges,
  dirtyPaths,
  onHide,
  onNavigated,
  treeOps,
  treeToolbar,
}: {
  lang: string;
  kbId: string;
  kbName: string;
  viewerId: string | null;
  tree: ReturnType<typeof useKbTree>;
  activePath: string | null;
  /** The open document's text (null while it loads); undefined: no document open. */
  outlineMarkdown: string | null | undefined;
  onOpen: (path: string, hash?: string, background?: boolean, keepFocus?: boolean) => void;
  /** A search hit: the version it was cited at (pinned when it isn't main's head). */
  onOpenHit: (path: string, hash: string | undefined, rev: string) => void;
  badges?: ReadonlyMap<string, ReactNode>;
  dirtyPaths?: ReadonlySet<string>;
  onHide?: () => void;
  /** A jump inside the open document (outline): the phone drawer closes. */
  onNavigated?: () => void;
  /** The tree's file operations (writers only; `useTreeFileOps`). */
  treeOps?: ReturnType<typeof useTreeFileOps>["treeProps"];
  treeToolbar?: ReactNode;
}) {
  const { t } = useTranslation("kb");
  const view = useKbWorkspaceLayout((layout) => layout.sidebarView);
  const setView = useKbWorkspaceLayout((layout) => layout.setSidebarView);
  const list = tree.isPending ? (
    <div className="space-y-2 p-3">
      <Skeleton className="h-6 w-3/4" />
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-6 w-1/2" />
    </div>
  ) : tree.isError && tree.paths.length === 0 ? (
    <div className="p-3">
      <InlineRetry message={t("workspace.shell.treeLoadFailed")} onRetry={tree.refetch} />
    </div>
  ) : tree.paths.length === 0 && !treeOps?.onDropFiles ? (
    <p className="p-3 text-sm text-muted-foreground">{t("detail.documentsEmpty")}</p>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col">
      {tree.paths.length === 0 && (
        // A writer's empty tree stays a drop area for the first files.
        <p className="p-3 text-sm text-muted-foreground">{t("detail.documentsEmpty")}</p>
      )}
      <FileTree
        paths={tree.paths}
        activePath={activePath}
        dirtyPaths={dirtyPaths}
        badges={badges}
        onOpen={(path, options) => onOpen(path, undefined, options?.newTab, options?.keyboard)}
        {...treeOps}
        ariaLabel={t("workspace.tree.label")}
        className="min-h-0 flex-1"
      />
      {tree.isError ? (
        // A later page failed: the files so far stay listed, and say they are partial.
        <div className="border-t p-2">
          <InlineRetry message={t("workspace.shell.treePartial")} onRetry={tree.retryMore} />
        </div>
      ) : (
        tree.truncated && (
          <p className="border-t p-3 text-xs text-muted-foreground">
            {t("workspace.shell.treeTruncated", { count: tree.paths.length })}
          </p>
        )
      )}
    </div>
  );
  const files = treeToolbar ? (
    <div className="flex min-h-0 flex-1 flex-col">
      {treeToolbar}
      {list}
    </div>
  ) : (
    list
  );
  return (
    <>
      {/* In the phone drawer its title already names the KB. */}
      <div
        className={cn("flex min-h-11 items-center gap-1 border-b px-2", !onHide && "max-lg:hidden")}
      >
        <p className="min-w-0 flex-1 truncate px-1 text-sm font-semibold">{kbName}</p>
        {onHide && (
          <Button
            variant="ghost"
            size="icon-touch"
            aria-label={t("workspace.shell.hideTree")}
            title={t("workspace.shell.hideTree")}
            onClick={onHide}
          >
            <PanelLeftClose aria-hidden className="size-4" />
          </Button>
        )}
      </div>
      <WorkspaceSidebar
        view={view}
        onViewChange={setView}
        files={files}
        search={<SidebarSearch lang={lang} kbId={kbId} onOpen={onOpenHit} />}
        activity={
          <RecentChangesPanel
            lang={lang}
            kbId={kbId}
            viewerId={viewerId}
            onOpen={(path) => onOpen(path)}
          />
        }
        outline={
          outlineMarkdown === undefined || activePath === null ? null : (
            <OutlinePanel
              lang={lang}
              kbId={kbId}
              path={activePath}
              markdown={outlineMarkdown}
              onNavigate={onNavigated}
            />
          )
        }
      />
    </>
  );
}
