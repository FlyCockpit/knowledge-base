import { Button } from "@knowledge-base/ui/components/button";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { Input } from "@knowledge-base/ui/components/input";
import { Label } from "@knowledge-base/ui/components/label";
import { toast } from "@knowledge-base/ui/components/sileo";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { Textarea } from "@knowledge-base/ui/components/textarea";
import { cn } from "@knowledge-base/ui/lib/utils";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ImagePlus } from "lucide-react";
import { type ReactNode, useDeferredValue, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { type MarkdownContext, MarkdownView } from "@/components/kb/markdown-view";
import type { AssetRef } from "@/components/kb/media";
import { SegmentedControl } from "@/components/segmented-control";
import { useFileDropTarget } from "@/hooks/use-file-drop-target";
import {
  confirmableConflict,
  DOCUMENT_STAGED_ASSETS_MAX,
  EDITOR_IMAGE_MIMES,
  type EditorOutcome,
  type EditorStagedImage,
  type ImageStageRun,
  type KbControls,
  kbControls,
  previewAfterSaves,
  useKbEditor,
} from "@/hooks/use-kb-editor";
import { orpc } from "@/utils/orpc";

const short = (sha: string) => sha.slice(0, 12);

type DocumentEditorViewProps = {
  lang: string;
  kbId: string;
  path: string;
  isNew: boolean;
  markdown: string;
  onMarkdownChange: (markdown: string) => void;
  onPathChange: (path: string) => void;
  controls: KbControls;
  /** Non-null when viewing a pinned (e.g. cited) commit instead of the branch head. */
  viewingRevision: string | null;
  baseRevision: string;
  outcome: EditorOutcome | null;
  pending: boolean;
  paused?: boolean;
  onSave: () => void;
  onAdoptHead: () => void;
  onOpenLatest?: () => void;
  /** The path line under the controls; off where a document header already names it. */
  showPath?: boolean;
  /**
   * Where the live preview resolves relative media: the revision the draft
   * was loaded at and that revision's asset manifest.
   */
  preview: { rev: string; assets: readonly AssetRef[] };
  /** Images staged for the next save, previewed from local object URLs (R3-W7). */
  stagedImages?: readonly EditorStagedImage[];
  /**
   * The new document's path is fixed: a save naming it is unresolved (a lost
   * create reply). Renaming then would leave a stray copy at the old path.
   */
  pathLocked?: boolean;
  /**
   * The write target no longer accepts writes (a CLOSED or MERGED proposal):
   * the draft stays readable, with no save, image upload or proposal note.
   */
  closed?: boolean;
  /** Image upload; absent where images can't be added. */
  image?: {
    /**
     * `at` is the textarea selection when the files arrived, or the end of
     * the draft while the textarea was never focused (R3-W7).
     */
    onFiles: (files: File[], at: { start: number; end: number }) => void;
    status: ImageStatus | null;
  };
};

export type ImageStatus =
  | { kind: "uploading"; name: string; percent: number }
  | { kind: "waiting"; name: string; seconds: number }
  /** Uploaded and linked; committed by the next save (R3-W7). */
  | { kind: "staged"; name: string }
  | {
      kind: "error";
      name: string;
      error: Extract<ImageStageRun, { ok: false }>["error"];
    };

/** Files carried by a paste, in order. */
function pastedFiles(list: DataTransfer | null): File[] {
  if (!list) return [];
  return Array.from(list.files);
}

function ImageStatusLine({ status }: { status: ImageStatus }) {
  const { t } = useTranslation("kb");
  if (status.kind === "error")
    return (
      <p role="alert" data-testid="editor-image-status" className="text-sm text-destructive">
        {t(`editor.image.error.${status.error}`, { name: status.name })}
      </p>
    );
  return (
    <div role="status" data-testid="editor-image-status" className="space-y-1 text-sm">
      <p>
        {status.kind === "uploading"
          ? t("editor.image.uploading", { name: status.name, percent: status.percent })
          : status.kind === "waiting"
            ? t("editor.image.waiting", { name: status.name, seconds: status.seconds })
            : t("editor.image.staged", { name: status.name })}
      </p>
      {status.kind === "uploading" && (
        <progress
          className="h-1.5 w-full max-w-xs accent-primary"
          max={100}
          value={status.percent}
          aria-label={t("editor.image.progressLabel", { name: status.name })}
        />
      )}
    </div>
  );
}

/**
 * The path a write sends. Only a new document's typed path is trimmed; an
 * existing document keeps its exact path (" a.md" and "a.md" are distinct
 * KB paths), so reads that back a decision use this same value.
 */
export function submitPath(path: string, isNew: boolean): string {
  return isNew ? path.trim() : path;
}

/**
 * Live preview of the draft through the one safe renderer:
 * same raw-HTML, URL and media rules as the viewer, so typing never fetches
 * remote content. Rendering is deferred so typing stays responsive.
 */
function DraftPreview({
  lang,
  kbId,
  path,
  markdown,
  preview,
  stagedImages,
  hidden,
}: Pick<
  DocumentEditorViewProps,
  "lang" | "kbId" | "path" | "markdown" | "preview" | "stagedImages"
> & {
  /** Hidden below `lg` while the Markdown tab is selected. */
  hidden: boolean;
}) {
  const { t } = useTranslation("kb");
  const headingId = useId();
  const deferred = useDeferredValue(markdown);
  const context = useMemo<MarkdownContext>(
    () => ({
      lang,
      kbId,
      rev: preview.rev,
      documentPath: path,
      assets: preview.assets,
      draft: true,
      fragmentPrefix: `preview-${headingId}-`,
      staged: stagedImages,
    }),
    [lang, kbId, preview.rev, path, preview.assets, stagedImages, headingId],
  );
  return (
    <section
      data-testid="editor-preview"
      aria-labelledby={headingId}
      className={cn("min-w-0 space-y-2", hidden && "hidden lg:block")}
    >
      <h3 id={headingId} className="text-sm font-medium">
        {t("editor.previewLabel")}
      </h3>
      <div className="min-h-[60svh] min-w-0 overflow-x-hidden rounded-md border bg-card p-4">
        <MarkdownView markdown={deferred} context={context} />
      </div>
    </section>
  );
}

/**
 * Where inserted images go (R3-W7): the selection of a textarea the user has
 * focused, else the end of the draft. A never-focused textarea reports a caret
 * at 0, which would glue the image onto the first line.
 */
export function imageInsertAt(
  focused: { selectionStart: number; selectionEnd: number } | null,
  length: number,
): { start: number; end: number } {
  return focused
    ? { start: focused.selectionStart, end: focused.selectionEnd }
    : { start: length, end: length };
}

export function DocumentEditorView(props: DocumentEditorViewProps) {
  const { t } = useTranslation(["kb", "common"]);
  const textareaId = useId();
  const pathId = useId();
  const imageHintId = useId();
  // State, not a ref: the drop registration follows the mounted element.
  const [textarea, setTextarea] = useState<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  // Below `lg` the editor and preview are tabs; side by side above it.
  const [pane, setPane] = useState<"write" | "preview">("write");
  const { controls, viewingRevision, outcome } = props;
  const editable = controls.editMode !== "none" && viewingRevision === null && !props.closed;
  const saveLabel = controls.editMode === "direct" ? t("kb:editor.save") : t("kb:editor.propose");
  const image = editable ? props.image : undefined;
  // The caret means something only once the user put it there: an untouched
  // textarea reports 0, which would glue an image onto the first line (R3-W7).
  const [touched, setTouched] = useState(false);
  const selection = () => imageInsertAt(touched ? textarea : null, props.markdown.length);
  const sendFiles = (files: File[]) => {
    if (image && files.length > 0 && !props.pending) image.onFiles(files, selection());
  };
  // Drops go through the document-level FileDropGuard registry (never a
  // second React onDrop); a read-only editor registers nothing.
  useFileDropTarget<Element>(image ? textarea : null, (files) => {
    setDragging(false);
    sendFiles(files);
  });

  return (
    <div className="min-w-0 space-y-4">
      {viewingRevision !== null && (
        <div role="status" className="rounded-md border p-3 text-sm">
          <p>{t("kb:editor.oldRevision", { sha: short(viewingRevision) })}</p>
          {props.onOpenLatest && (
            <Button variant="outline" className="mt-2 min-h-[44px]" onClick={props.onOpenLatest}>
              {t("kb:editor.openLatest")}
            </Button>
          )}
        </div>
      )}
      {editable && controls.editMode === "proposal" && (
        <p className="text-sm text-muted-foreground">{t("kb:editor.proposalNote")}</p>
      )}
      {viewingRevision === null && controls.editMode === "none" && (
        <p className="text-sm text-muted-foreground">{t("kb:editor.readOnlyNote")}</p>
      )}
      {props.isNew && editable ? (
        <div className="min-w-0 space-y-2">
          <Label htmlFor={pathId}>{t("kb:editor.pathLabel")}</Label>
          <Input
            id={pathId}
            value={props.path}
            readOnly={props.pathLocked}
            onChange={(e) => props.onPathChange(e.target.value)}
            autoComplete="off"
            inputMode="url"
            maxLength={512}
            placeholder={t("kb:editor.pathPlaceholder")}
          />
          <p className="text-xs text-muted-foreground">{t("kb:editor.pathHint")}</p>
        </div>
      ) : props.showPath !== false ? (
        <p className="truncate font-mono text-sm">{props.path}</p>
      ) : null}
      {editable && (
        <SegmentedControl
          className="lg:hidden"
          ariaLabel={t("kb:editor.paneLabel")}
          value={pane}
          onChange={setPane}
          items={[
            { value: "write", label: t("kb:editor.markdownLabel") },
            { value: "preview", label: t("kb:editor.previewLabel") },
          ]}
        />
      )}
      <div className={editable ? "grid min-w-0 gap-4 lg:grid-cols-2" : "min-w-0"}>
        <div className={cn("min-w-0 space-y-2", editable && pane !== "write" && "hidden lg:block")}>
          <div className="flex min-h-[44px] flex-wrap items-center justify-between gap-2">
            <Label htmlFor={textareaId}>{t("kb:editor.markdownLabel")}</Label>
            {image && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  data-testid="editor-insert-image"
                  disabled={props.pending}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <ImagePlus aria-hidden className="size-4" />
                  {t("kb:editor.image.insert")}
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  accept={EDITOR_IMAGE_MIMES.join(",")}
                  multiple
                  data-testid="editor-image-input"
                  onChange={(e) => {
                    sendFiles(Array.from(e.target.files ?? []));
                    // The same file can be chosen again after an error.
                    e.target.value = "";
                  }}
                />
              </>
            )}
          </div>
          {/* Raw Markdown editor: the bytes saved are exactly what is typed here. */}
          <Textarea
            ref={setTextarea}
            id={textareaId}
            data-testid="editor-markdown"
            value={props.markdown}
            onChange={(e) => props.onMarkdownChange(e.target.value)}
            readOnly={!editable}
            spellCheck
            aria-describedby={image ? imageHintId : undefined}
            onFocus={() => setTouched(true)}
            onDragOver={
              image
                ? (e) => {
                    if (e.dataTransfer.types.includes("Files")) setDragging(true);
                  }
                : undefined
            }
            onDragLeave={image ? () => setDragging(false) : undefined}
            onPaste={
              image
                ? (e) => {
                    const files = pastedFiles(e.clipboardData);
                    if (files.length === 0) return;
                    e.preventDefault();
                    sendFiles(files);
                  }
                : undefined
            }
            className={cn(
              "min-h-[60svh] font-mono text-sm leading-relaxed",
              dragging && "border-primary ring-2 ring-ring",
            )}
          />
          {image && (
            <p id={imageHintId} className="text-xs text-muted-foreground">
              {t("kb:editor.image.hint")}
            </p>
          )}
          {image?.status && <ImageStatusLine status={image.status} />}
        </div>
        {editable && (
          <DraftPreview
            hidden={pane !== "preview"}
            // Media resolve against the path the save will write.
            lang={props.lang}
            kbId={props.kbId}
            path={submitPath(props.path, props.isNew)}
            markdown={props.markdown}
            preview={props.preview}
            stagedImages={props.stagedImages}
          />
        )}
      </div>
      {props.paused && (
        <p role="status" className="text-sm">
          {t("kb:editor.offline")}
        </p>
      )}
      {outcome && <EditorOutcomeNotice {...props} outcome={outcome} />}
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="editor-save"
            className="min-h-[44px]"
            disabled={props.pending}
            onClick={props.onSave}
          >
            {props.pending ? t("kb:editor.saving") : saveLabel}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t("kb:editor.baseRevision", { sha: short(props.baseRevision) })}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * The document at one exact reported revision (a branch or proposal head).
 * A decision about that revision (overwrite it, delete it) is enabled only
 * once this read succeeded and its content is on screen; a failed read
 * offers Retry instead. Revisions are immutable, so the cached read is exact.
 */
function useRevisionRead(kbId: string, path: string, rev: string | null) {
  const read = useQuery(
    orpc.documents.get.queryOptions({
      // Exactly the path the mutation sends: " a.md" and "a.md" are distinct.
      input: rev ? { kbId, path, rev } : skipToken,
      retry: false,
      // Absent at a revision is an expected answer, shown inline (and a
      // failed read offers Retry there): no global toast on top.
      meta: { skipGlobalErrorToast: true },
    }),
  );
  const missing = read.isError && (read.error as { code?: unknown } | null)?.code === "NOT_FOUND";
  return { read, missing, ready: read.isSuccess && Boolean(read.data) };
}

function RevisionPreview({
  lang,
  kbId,
  rev,
  state,
}: {
  lang: string;
  kbId: string;
  rev: string;
  state: ReturnType<typeof useRevisionRead>;
}) {
  const { t } = useTranslation("kb");
  const { read, missing } = state;
  const fragmentPrefix = `revision-${useId()}-`;
  if (read.isPending)
    return (
      <div
        data-testid="revision-preview"
        data-state="loading"
        aria-busy="true"
        className="space-y-2"
      >
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  if (missing)
    return (
      <p
        data-testid="revision-preview"
        data-state="missing"
        className="text-sm text-muted-foreground"
      >
        {t("outcome.headMissing", { sha: short(rev) })}
      </p>
    );
  if (read.isError || !read.data)
    return (
      <div data-testid="revision-preview" data-state="error">
        <InlineRetry
          variant="destructive"
          message={t("outcome.headReadFailed", { sha: short(rev) })}
          onRetry={() => read.refetch()}
        />
      </div>
    );
  return (
    <section
      data-testid="revision-preview"
      data-state="ready"
      data-rev={read.data.commitSha}
      aria-label={t("outcome.headPreview", { sha: short(read.data.commitSha) })}
      className="max-h-64 min-w-0 space-y-2 overflow-x-hidden overflow-y-auto overscroll-contain rounded-md border bg-card p-3"
    >
      <p className="text-xs font-medium text-muted-foreground">
        {t("outcome.headPreview", { sha: short(read.data.commitSha) })}
      </p>
      <MarkdownView
        markdown={read.data.markdown}
        context={{
          lang,
          kbId,
          rev: read.data.commitSha,
          documentPath: read.data.path,
          fragmentPrefix,
          assets: read.data.assetRefs,
        }}
      />
    </section>
  );
}

/**
 * Save conflict: keeping the draft and saving onto the reported head replaces
 * that version, so it is shown first and adopting waits for a successful read
 * (a document that does not exist there has nothing to overwrite).
 */
function AdoptHead({
  lang,
  kbId,
  path,
  headSha,
  onAdoptHead,
}: {
  lang: string;
  kbId: string;
  path: string;
  headSha: string;
  onAdoptHead: () => void;
}) {
  const { t } = useTranslation("kb");
  const state = useRevisionRead(kbId, path, headSha);
  return (
    <>
      <p>{t("outcome.conflictBody")}</p>
      <CopyField value={headSha} copyLabel={t("outcome.conflictBody")} />
      <RevisionPreview lang={lang} kbId={kbId} rev={headSha} state={state} />
      <p className="text-xs text-muted-foreground">{t("outcome.adoptHint")}</p>
      <Button
        variant="outline"
        className="min-h-[44px]"
        disabled={!state.ready && !state.missing}
        onClick={onAdoptHead}
      >
        {t("outcome.adoptHead")}
      </Button>
    </>
  );
}

function EditorOutcomeNotice({
  lang,
  kbId,
  path,
  isNew,
  outcome,
  onAdoptHead,
}: Pick<DocumentEditorViewProps, "lang" | "kbId" | "path" | "isNew" | "onAdoptHead"> & {
  outcome: EditorOutcome;
}) {
  const { t } = useTranslation("kb");
  const box = "min-w-0 space-y-2 rounded-md border p-3 text-sm";
  switch (outcome.kind) {
    case "applied":
      return (
        <div role="status" className={box}>
          <p className="font-medium">{t("outcome.appliedTitle")}</p>
          <p className="font-mono text-xs">
            {t("outcome.commit", { sha: short(outcome.commitSha) })}
          </p>
          <p>{outcome.indexJobId ? t("outcome.indexQueued") : t("outcome.indexNone")}</p>
        </div>
      );
    case "proposed":
      return (
        <div role="status" className={box}>
          <p className="font-medium">
            {t(outcome.created ? "outcome.proposalCreatedTitle" : "outcome.proposedTitle", {
              number: outcome.proposalNumber,
            })}
          </p>
          <p>{t("outcome.proposedBody")}</p>
          <Link
            className="inline-flex min-h-[44px] items-center underline"
            to="/$lang/kbs/$kbId/prs/$number"
            params={{ lang, kbId: kbId, number: String(outcome.proposalNumber) }}
          >
            {t("outcome.openProposal", { number: outcome.proposalNumber })}
          </Link>
        </div>
      );
    case "noop":
      return (
        <div role="status" className={box}>
          <p className="font-medium">{t("outcome.noopTitle")}</p>
          <p>{t("outcome.noopBody")}</p>
        </div>
      );
    case "conflict":
      if (outcome.proposalConflict && outcome.proposalNumber !== null)
        return (
          <ProposalConflictNotice
            lang={lang}
            kbId={kbId}
            number={outcome.proposalNumber}
            paths={outcome.proposalConflict.paths}
            className={`${box} border-destructive/40`}
          />
        );
      return (
        <div role="alert" className={`${box} border-destructive/40`}>
          <p className="font-medium">
            {outcome.proposalNumber !== null
              ? // The PR moved since it was read (another editor or tab): show
                // its current version; nothing is resent without a decision.
                t("outcome.proposalMovedTitle", { number: outcome.proposalNumber })
              : t("outcome.conflictTitle")}
          </p>
          {outcome.headSha ? (
            <AdoptHead
              lang={lang}
              kbId={kbId}
              path={submitPath(path, isNew)}
              headSha={outcome.headSha}
              onAdoptHead={onAdoptHead}
            />
          ) : (
            <p>{t("outcome.conflictUnknown")}</p>
          )}
        </div>
      );
    case "retryable":
      return (
        <p role="alert" className="text-sm text-destructive">
          {t("editor.retryable")}
        </p>
      );
    case "error":
      return (
        <p role="alert" className="text-sm text-destructive">
          {t(outcome.reason === "unknown" ? "editor.error" : `editor.${outcome.reason}`, {
            max: DOCUMENT_STAGED_ASSETS_MAX,
          })}
        </p>
      );
  }
}

/**
 * PROPOSAL_CONFLICT: the save reached the proposal but resolved none of
 * the paths it still conflicts on. Nothing was saved; the draft is kept.
 */
function ProposalConflictNotice({
  lang,
  kbId,
  number,
  paths,
  className,
}: {
  lang: string;
  kbId: string;
  number: number;
  paths: readonly { path: string; kind: "document" | "asset" }[];
  className: string;
}) {
  const { t } = useTranslation("kb");
  return (
    <div role="alert" data-testid="editor-proposal-conflict" className={className}>
      <p className="font-medium">{t("outcome.proposalConflictTitle", { number })}</p>
      <p>{t("outcome.proposalConflictBody", { number })}</p>
      {paths.length > 0 && (
        <ul className="list-disc space-y-1 pl-5">
          {paths.map((item) => (
            <li key={`${item.kind}:${item.path}`} className="text-xs">
              <span className="font-mono break-all">{item.path}</span>
              {item.kind === "document" && (
                <>
                  {" "}
                  <Link
                    data-testid="editor-proposal-conflict-resolve"
                    aria-label={t("pr.conflicts.resolvePath", { path: item.path })}
                    className="inline-flex min-h-[44px] items-center underline"
                    to="/$lang/kbs/$kbId/documents"
                    params={{ lang, kbId }}
                    search={{ path: item.path, mode: "edit", pr: number }}
                  >
                    {t("pr.conflicts.resolve")}
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <Link
        className="inline-flex min-h-[44px] items-center underline"
        to="/$lang/kbs/$kbId/prs/$number"
        params={{ lang, kbId: kbId, number: String(number) }}
      >
        {t("outcome.openProposal", { number })}
      </Link>
    </div>
  );
}

/** Alt text inside a Markdown image: drops characters that would end it. */
const altText = (name: string) =>
  name
    .replace(/[[\]\\\n\r]/g, " ")
    .trim()
    .slice(0, 120);

/** Line breaks that put `block` on its own paragraph between `before` and `after`. */
function paragraphBreaks(before: string, after: string): { lead: string; trail: string } {
  const pad = (edge: string, empty: boolean) =>
    empty || edge.endsWith("\n\n") ? "" : edge.endsWith("\n") ? "\n" : "\n\n";
  const lead = pad(before, before.length === 0);
  const trail =
    after.length === 0 || after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return { lead, trail };
}

/**
 * Inserts dropped, pasted or chosen images into the draft (R3-W7). Each
 * image is its own paragraph: a blank line before it (unless at the start)
 * and after it (unless at the end), and several images are separated by
 * blank lines, so a link never joins a heading or another image. Typing
 * stays enabled during uploads, so the position is not kept as an offset: a
 * unique placeholder link is written at once and moves with every edit. Each
 * staged image replaces its placeholder (or is appended if the user deleted
 * it); a failure removes the placeholders left and, when nothing was
 * inserted, puts the replaced selection back.
 */
export async function insertImagesIntoDraft<F extends { name: string }>({
  files,
  at,
  selected,
  newId,
  placeholderAlt,
  updateDraft,
  insert,
  onStatus,
}: {
  files: readonly F[];
  at: { start: number; end: number };
  /** The text the selection covered, restored if nothing gets inserted. */
  selected: string;
  newId: () => string;
  placeholderAlt: (name: string) => string;
  updateDraft: (update: (draft: string) => string) => void;
  insert: (
    file: F,
    report: {
      onProgress: (sent: number, total: number) => void;
      onWait: (seconds: number) => void;
    },
  ) => Promise<ImageStageRun | undefined>;
  onStatus: (status: ImageStatus | null) => void;
}): Promise<void> {
  const tokens = files.map(
    (file) => `![${altText(placeholderAlt(file.name || "image"))}](kb-upload:${newId()})`,
  );
  const separator = "\n\n";
  let inserted = "";
  updateDraft((draft) => {
    const from = Math.min(at.start, draft.length);
    const to = Math.min(Math.max(at.end, from), draft.length);
    const before = draft.slice(0, from);
    const after = draft.slice(to);
    const { lead, trail } = paragraphBreaks(before, after);
    inserted = lead + tokens.join(separator) + trail;
    return before + inserted + after;
  });
  const settle = (token: string, text: string) =>
    updateDraft((draft) => {
      if (draft.includes(token)) return draft.replace(token, () => text);
      // The placeholder was edited away: keep the staged image linked.
      return `${draft}${paragraphBreaks(draft, "").lead}${text}`;
    });
  const abandon = (from: number) =>
    updateDraft((draft) => {
      // Nothing inserted yet: put the text back exactly as it was.
      if (from === 0 && inserted && draft.includes(inserted))
        return draft.replace(inserted, () => selected);
      return tokens
        .slice(from)
        .reduce(
          (next, token) =>
            next.includes(`${separator}${token}`)
              ? next.replace(`${separator}${token}`, "")
              : next.replace(token, ""),
          draft,
        );
    });
  for (const [index, file] of files.entries()) {
    const name = file.name || "image";
    const token = tokens[index] ?? "";
    onStatus({ kind: "uploading", name, percent: 0 });
    const run = await insert(file, {
      onProgress: (sent, total) =>
        onStatus({
          kind: "uploading",
          name,
          percent: Math.floor((Math.min(sent, total) / Math.max(1, total)) * 100),
        }),
      onWait: (seconds) => onStatus({ kind: "waiting", name, seconds }),
    });
    // A retired session or a save already in flight: nothing was sent.
    if (!run?.ok) {
      abandon(index);
      onStatus(run ? { kind: "error", name, error: run.error } : null);
      return;
    }
    settle(token, run.markdown);
    onStatus({ kind: "staged", name });
  }
}

type EditorKb = { id: string; headSha: string | null; capabilities: readonly string[] };

/** One editing session: the draft, the base revision and the last outcome. */
export type KbEditorSession = ReturnType<typeof useKbEditor>;

type EditorProps = {
  lang: string;
  kb: EditorKb;
  /** A new draft: its path is typed (and fixed by its first save record). */
  isNew: boolean;
  viewingRevision: string | null;
  preview: { rev: string; assets: readonly AssetRef[] };
  onOpenLatest: (path: string) => void;
  /** A save of the existing document opened or extended this proposal. */
  onProposed?: (proposalNumber: number, created: boolean) => void;
  /** See `DocumentEditorViewProps.closed`. */
  closed?: boolean;
};

/**
 * One editing session of a document: the raw draft lives in `useKbEditor`
 * and is sent exactly as typed; the preview renders that same draft.
 */
export function KbDocumentEditor({
  initialPath,
  initialMarkdown,
  ...props
}: EditorProps & { initialPath: string; initialMarkdown: string }) {
  // Text and base come from the same immutable read, even when the separately
  // cached KB head has advanced. New drafts pin their opening head.
  const editor = useKbEditor({
    target: {
      kbId: props.kb.id,
      path: props.isNew ? "" : initialPath,
      target: { kind: "main", rev: props.viewingRevision },
    },
    initialMarkdown,
    baseRevision: props.preview.rev,
    initialExists: !props.isNew,
  });
  return <KbSessionEditor {...props} editor={editor} />;
}

/**
 * The editor over a session its page owns, so the document header's Delete
 * writes against the same base the editor advanced to (e.g. a proposal head).
 * The session owns the path and whether the document exists: Save only says
 * "write this draft".
 */
export function KbSessionEditor({
  lang,
  kb,
  isNew,
  viewingRevision,
  preview,
  onOpenLatest,
  onProposed,
  closed,
  editor,
}: EditorProps & { editor: KbEditorSession }) {
  const [imageStatus, setImageStatus] = useState<ImageStatus | null>(null);
  // Without a branch head there is no base revision to write against.
  const controls = kb.headSha
    ? kbControls(kb.capabilities)
    : { ...kbControls(kb.capabilities), editMode: "none" as const };
  const { t } = useTranslation("kb");
  // Uploads keep typing enabled but Save waits: placeholders must not be saved.
  const [imageBusy, setImageBusy] = useState(false);
  const effectivePreview = useMemo(
    () => previewAfterSaves({ rev: preview.rev, assets: preview.assets }, editor.committed),
    [preview.rev, preview.assets, editor.committed],
  );
  const onFiles = async (files: File[], at: { start: number; end: number }) => {
    setImageBusy(true);
    try {
      await insertImagesIntoDraft({
        files,
        at,
        selected: editor.markdown.slice(at.start, at.end),
        newId: () => crypto.randomUUID(),
        placeholderAlt: (name) => t("editor.image.placeholder", { name }),
        updateDraft: editor.setMarkdown,
        insert: (file, report) => editor.insertImage(file, report.onProgress, report.onWait),
        onStatus: setImageStatus,
      });
    } finally {
      setImageBusy(false);
    }
  };
  const drafting = isNew && !editor.exists;
  return (
    <DocumentEditorView
      lang={lang}
      kbId={kb.id}
      path={editor.path}
      markdown={editor.markdown}
      onMarkdownChange={editor.setMarkdown}
      onPathChange={editor.setPath}
      controls={controls}
      viewingRevision={viewingRevision}
      baseRevision={editor.baseRevision}
      outcome={editor.outcome}
      pending={editor.pending || imageBusy}
      paused={editor.paused}
      pathLocked={!editor.pathEditable}
      closed={closed}
      onAdoptHead={editor.adoptHead}
      onOpenLatest={() => onOpenLatest(editor.path)}
      isNew={drafting}
      showPath={isNew}
      // After a save the preview reads the revision it produced (R3-W7).
      preview={effectivePreview}
      stagedImages={editor.stagedImages}
      image={{ onFiles: (files, at) => void onFiles(files, at), status: imageStatus }}
      onSave={async () => {
        // A typed path is trimmed once, as the record that fixes it is made.
        if (drafting) editor.setPath(submitPath(editor.path, true));
        const outcome = await editor.submit({ kind: "write", markdown: editor.markdown });
        if (
          outcome?.kind === "applied" ||
          outcome?.kind === "proposed" ||
          outcome?.kind === "noop"
        ) {
          // The staged images were committed with the save.
          setImageStatus(null);
          // A create moves the session's own target (the page follows it);
          // an existing document's save may open or extend a proposal.
          if (!drafting && outcome.kind === "proposed")
            onProposed?.(outcome.proposalNumber, outcome.created);
        }
      }}
    />
  );
}

type StaleDelete = { headSha: string; proposalNumber: number | null };

/**
 * Delete document, a document-header action. It sends the
 * delete through the page's editing session, so after a proposed edit it
 * targets that proposal's head. A conflict (the document moved, or the
 * caller's open proposal is ahead) re-reads the document and asks again
 * against the reported head; nothing is resent without that confirmation.
 */
export function KbDocumentDelete({
  lang,
  kbId,
  editor,
  proposing = false,
  onDeleted,
}: {
  lang: string;
  kbId: string;
  editor: KbEditorSession;
  proposing?: boolean;
  onDeleted: () => void;
}) {
  const { t } = useTranslation(["kb", "common"]);
  // The session's own document: the one its delete record names.
  const { path } = editor;
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [stale, setStale] = useState<StaleDelete | null>(null);
  const head = useRevisionRead(kbId, path, stale?.headSha ?? null);
  const send = async (rebase?: StaleDelete) => {
    setOpen(false);
    const outcome = await editor.submit({ kind: "delete" }, rebase);
    // A retired page (another KB opened meanwhile) gets no outcome.
    if (!outcome) return;
    setStale(null);
    switch (outcome.kind) {
      case "applied":
      case "noop":
        onDeleted();
        return;
      case "proposed":
        toast.success(
          t(outcome.created ? "kb:outcome.proposalCreatedTitle" : "kb:outcome.proposedTitle", {
            number: outcome.proposalNumber,
          }),
        );
        return;
      case "conflict": {
        const confirmable = confirmableConflict(outcome, { kind: "document", path });
        if (!confirmable) {
          toast.error(
            outcome.proposalConflict && outcome.proposalNumber !== null
              ? t("kb:outcome.proposalConflictTitle", { number: outcome.proposalNumber })
              : t("kb:outcome.conflictUnknown"),
          );
          return;
        }
        // Ask again about the exact reported head (a moved document, or the
        // caller's open proposal that changed it), shown in the dialog once
        // it has been read. The page's own view refreshes in the background.
        void queryClient.invalidateQueries({ queryKey: orpc.documents.key() });
        setStale(confirmable);
        setOpen(true);
        return;
      }
      case "retryable":
        toast.error(t("kb:editor.retryable"));
        return;
      case "error":
        toast.error(
          t(outcome.reason === "unknown" ? "kb:editor.error" : `kb:editor.${outcome.reason}`),
        );
    }
  };
  return (
    <>
      <Button
        variant="destructive"
        size="touch"
        disabled={editor.pending}
        onClick={() => {
          setStale(null);
          setOpen(true);
        }}
      >
        {t("kb:editor.delete")}
      </Button>
      <ConfirmDeleteDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setStale(null);
        }}
        title={t("kb:editor.deleteTitle", { path })}
        description={
          !stale
            ? t(
                proposing || editor.proposal
                  ? "kb:editor.deleteProposalDescription"
                  : "kb:editor.deleteDescription",
              )
            : stale.proposalNumber !== null
              ? t("kb:editor.deleteStaleProposal", {
                  number: stale.proposalNumber,
                  sha: stale.headSha.slice(0, 12),
                })
              : t("kb:editor.deleteStale", { sha: stale.headSha.slice(0, 12) })
        }
        confirmToken="DELETE"
        typePrompt={t("kb:editor.deletePrompt")}
        copyAriaLabel={t("kb:editor.copyToken")}
        isPending={editor.pending}
        // Reconfirming deletes the reported head: only after it was read and shown.
        disabled={stale !== null && !head.ready}
        onConfirm={() => void send(stale ?? undefined)}
      >
        {stale && <RevisionPreview lang={lang} kbId={kbId} rev={stale.headSha} state={head} />}
      </ConfirmDeleteDialog>
    </>
  );
}

type ProposalModeKb = EditorKb;

/**
 * PR mode (R3-W6): edit a document as the viewer's pull request has it. The
 * draft starts from the PR's version (main's, said so, when the PR deletes
 * it); main's version ("theirs") and, for a conflicting path, the common
 * base are shown read-only. Saves go against current main with the PR's
 * number, which moves the PR onto main and resolves this path's conflict.
 */
export function KbProposalDocumentEditor({
  lang,
  kb,
  number,
  path,
  onLeave,
}: {
  lang: string;
  kb: ProposalModeKb;
  number: number;
  path: string;
  /** Leave PR mode: open the document as main has it. */
  onLeave: () => void;
}) {
  const { t } = useTranslation("kb");
  const {
    data: conflicts,
    isPending: conflictsPending,
    isError: conflictsFailed,
    refetch: refetchConflicts,
  } = useQuery(
    orpc.pullRequests.conflicts.queryOptions({ input: { kbId: kb.id, number }, retry: false }),
  );
  const box = "min-w-0 space-y-2 rounded-md border p-3 text-sm";
  const leave = (
    <Button variant="outline" className="min-h-[44px]" onClick={onLeave}>
      {t("prMode.leave")}
    </Button>
  );
  if (conflictsPending) return <ProposalModeSkeleton />;
  if (conflictsFailed || !conflicts)
    return (
      <InlineRetry
        message={t("prMode.loadFailed", { number })}
        onRetry={() => refetchConflicts()}
      />
    );
  if (conflicts.status !== "OPEN" && conflicts.status !== "CONFLICT")
    return (
      <div role="status" data-testid="pr-mode" data-state="inactive" className={box}>
        <p>{t("prMode.inactive", { number })}</p>
        {leave}
      </div>
    );
  // A dream's PR stays with the run that dreamed it: never edited here.
  if (conflicts.isDream)
    return (
      <div role="status" data-testid="pr-mode" data-state="dream" className={box}>
        <p>{t("prMode.dream", { number })}</p>
        {leave}
      </div>
    );
  const entry =
    conflicts.paths.find((item) => item.kind === "document" && item.path === path) ?? null;
  return (
    <ProposalModeVersions
      // Versions are pinned when PR mode opens; a later refetch of the PR
      // (e.g. after a save moved it) never replaces the draft being edited.
      key={`${kb.id}:${number}:${path}`}
      lang={lang}
      kb={kb}
      number={number}
      path={path}
      opened={{
        yoursSha: entry?.yoursSha ?? conflicts.headSha,
        mainSha: conflicts.targetSha,
        prHeadSha: conflicts.headSha,
        entry,
      }}
      leave={leave}
    />
  );
}

function ProposalModeSkeleton() {
  return (
    <div data-testid="pr-mode" data-state="loading" aria-busy="true" className="space-y-3">
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-[50svh] w-full" />
    </div>
  );
}

type ProposalModeEntry = { baseSha: string; theirsSha: string; standing: boolean };

function ProposalModeVersions({
  lang,
  kb,
  number,
  path,
  opened,
  leave,
}: {
  lang: string;
  kb: ProposalModeKb;
  number: number;
  path: string;
  opened: {
    yoursSha: string;
    mainSha: string;
    /** The PR head read when PR mode opened: every write names it. */
    prHeadSha: string;
    entry: ProposalModeEntry | null;
  };
  leave: ReactNode;
}) {
  const { t } = useTranslation("kb");
  const [{ yoursSha, mainSha, prHeadSha, entry }] = useState(opened);
  const yours = useRevisionRead(kb.id, path, yoursSha);
  const theirs = useRevisionRead(kb.id, path, mainSha);
  const box = "min-w-0 space-y-2 rounded-md border p-3 text-sm";
  if (yours.read.isPending || theirs.read.isPending) return <ProposalModeSkeleton />;
  for (const state of [yours, theirs])
    if (state.read.isError && !state.missing)
      return (
        <InlineRetry
          message={t("prMode.loadFailed", { number })}
          onRetry={() => void state.read.refetch()}
        />
      );
  const source = yours.read.data ?? theirs.read.data ?? null;
  // A conflicted path absent on both sides is resolved by keeping the
  // deletion: never the generic "missing" display.
  if (!source && !entry)
    return (
      <div role="status" data-testid="pr-mode" data-state="missing" className={box}>
        <p>{t("prMode.missing", { number })}</p>
        {leave}
      </div>
    );
  return (
    <ProposalModeSession
      lang={lang}
      kb={kb}
      number={number}
      path={path}
      mainSha={mainSha}
      prHeadSha={prHeadSha}
      entry={entry}
      deleted={yours.missing}
      onMain={theirs.read.data !== undefined}
      source={source}
      leave={leave}
    />
  );
}

function ProposalModeSession({
  lang,
  kb,
  number,
  path,
  mainSha,
  prHeadSha,
  entry,
  deleted,
  onMain,
  source,
  leave,
}: {
  lang: string;
  kb: ProposalModeKb;
  number: number;
  path: string;
  /** Current main when PR mode opened: every save goes against it. */
  mainSha: string;
  prHeadSha: string;
  entry: ProposalModeEntry | null;
  /** The PR deletes this document: the draft starts from main's version. */
  deleted: boolean;
  onMain: boolean;
  /** The version the draft starts from; null when both sides deleted it. */
  source: { markdown: string; commitSha: string; assetRefs: AssetRef[] } | null;
  leave: ReactNode;
}) {
  const { t } = useTranslation("kb");
  // Writes go against main with the PR named at the head PR mode read.
  const editor = useKbEditor({
    target: { kbId: kb.id, path, target: { kind: "proposal", number } },
    initialMarkdown: source?.markdown ?? "",
    baseRevision: mainSha,
    proposalHead: prHeadSha,
    initialExists: !deleted,
  });
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const theirs = useRevisionRead(kb.id, path, entry?.theirsSha ?? mainSha);
  const base = useRevisionRead(kb.id, path, entry?.baseSha ?? null);
  const writable = kbControls(kb.capabilities).editMode !== "none";
  // The receipt survives later edits and failed saves; a resolved comparison
  // must not reappear when the latest outcome is replaced.
  const resolved = editor.committed !== null;
  const summary = "flex min-h-[44px] cursor-pointer items-center text-sm font-medium";
  return (
    <div data-testid="pr-mode" data-state="ready" className="min-w-0 space-y-4">
      <div
        role="status"
        className="min-w-0 space-y-2 rounded-md border border-primary/40 p-3 text-sm"
      >
        <p className="font-medium">{t("prMode.title", { number })}</p>
        <p>{t("prMode.body")}</p>
        {!resolved && entry && source && (
          <p data-testid="pr-mode-conflict">
            {t(entry.standing ? "prMode.standing" : "prMode.conflict")}
          </p>
        )}
        {!source ? (
          <p data-testid="pr-mode-both-deleted">{t("prMode.bothDeleted", { number })}</p>
        ) : deleted ? (
          <p data-testid="pr-mode-deleted">{t("prMode.deleted", { number })}</p>
        ) : (
          !onMain && <p data-testid="pr-mode-main-deleted">{t("prMode.mainDeleted")}</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Link
            className="inline-flex min-h-[44px] items-center underline"
            to="/$lang/kbs/$kbId/prs/$number"
            params={{ lang, kbId: kb.id, number: String(number) }}
          >
            {t("outcome.openProposal", { number })}
          </Link>
          {leave}
          {entry && (deleted || !onMain) && writable && (
            // The server accepts a delete of a conflicted path even where it
            // is already absent: that resolves the recorded conflict.
            <Button
              data-testid="pr-mode-delete"
              variant="outline"
              className="min-h-[44px]"
              disabled={editor.pending || resolved}
              onClick={() => setConfirmingDelete(true)}
            >
              {t(deleted ? "prMode.keepDeletion" : "prMode.acceptDeletion")}
            </Button>
          )}
        </div>
      </div>
      <ConfirmDeleteDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={t("prMode.deleteTitle", { path, number })}
        description={t(
          deleted ? "prMode.keepDeletionDescription" : "prMode.acceptDeletionDescription",
          {
            number,
          },
        )}
        confirmToken="DELETE"
        typePrompt={t("editor.deletePrompt")}
        copyAriaLabel={t("editor.copyToken")}
        confirmLabel={t(deleted ? "prMode.keepDeletion" : "prMode.acceptDeletion")}
        isPending={editor.pending}
        onConfirm={() => {
          setConfirmingDelete(false);
          void editor.submit({ kind: "delete" });
        }}
      />
      {!resolved && (
        <details className="min-w-0 rounded-md border px-3" open={entry !== null}>
          <summary className={summary}>{t("prMode.theirs")}</summary>
          <div className="pb-3">
            <RevisionPreview
              lang={lang}
              kbId={kb.id}
              rev={entry?.theirsSha ?? mainSha}
              state={theirs}
            />
          </div>
        </details>
      )}
      {!resolved && entry && (
        <details className="min-w-0 rounded-md border px-3">
          <summary className={summary}>{t("prMode.base")}</summary>
          <div className="pb-3">
            <RevisionPreview lang={lang} kbId={kb.id} rev={entry.baseSha} state={base} />
          </div>
        </details>
      )}
      {source ? (
        <KbSessionEditor
          lang={lang}
          kb={kb}
          isNew={false}
          editor={editor}
          viewingRevision={null}
          preview={{ rev: source.commitSha, assets: source.assetRefs }}
          onOpenLatest={() => {}}
        />
      ) : (
        editor.outcome && (
          <EditorOutcomeNotice
            lang={lang}
            kbId={kb.id}
            path={path}
            isNew={false}
            outcome={editor.outcome}
            onAdoptHead={editor.adoptHead}
          />
        )
      )}
    </div>
  );
}
