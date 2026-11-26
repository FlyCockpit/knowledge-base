import { Button } from "@knowledge-base/ui/components/button";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@knowledge-base/ui/components/dropdown-menu";
import { Input } from "@knowledge-base/ui/components/input";
import { Label } from "@knowledge-base/ui/components/label";
import { toast } from "@knowledge-base/ui/components/sileo";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { Textarea } from "@knowledge-base/ui/components/textarea";
import { cn } from "@knowledge-base/ui/lib/utils";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ImagePlus, MoreHorizontal } from "lucide-react";
import { type ReactNode, useDeferredValue, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { type MarkdownContext, MarkdownView } from "@/components/kb/markdown-view";
import type { AssetRef } from "@/components/kb/media";
import { SegmentedControl } from "@/components/segmented-control";
import {
  draftKey,
  readDraft,
  type StoredDraft,
  useDocumentDraft,
} from "@/hooks/use-document-draft";
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
  type PendingUpload,
  previewAfterSaves,
  useKbEditor,
} from "@/hooks/use-kb-editor";
import { documentPathIssue } from "@/lib/document-path";
import { joinProvenanceStamp, splitProvenanceStamp } from "@/lib/document-text";
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
  /** Images staged for the next save, previewed from local object URLs. */
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
  /**
   * The draft differs from what was last read or saved: the save bar says
   * "Unsaved changes" (and Discard, with `onDiscard`).
   */
  dirty?: boolean;
  onDiscard?: () => void;
  /** Leaves editing (the page's "Done"), at the end of the editor bar. */
  doneAction?: ReactNode;
  /** More document actions (e.g. Delete document) for the bar's overflow menu. */
  moreActions?: readonly MoreAction[];
  /** Image upload; absent where images can't be added. */
  image?: {
    /**
     * `at` is the textarea selection when the files arrived, or the end of
     * the draft while the textarea was never focused.
     */
    onFiles: (files: File[], at: { start: number; end: number }) => void;
    status: ImageStatus | null;
  };
};

export type ImageStatus =
  | { kind: "uploading"; name: string; percent: number }
  | { kind: "waiting"; name: string; seconds: number }
  /** Uploaded and linked; committed by the next save. */
  | { kind: "staged"; name: string }
  | {
      kind: "error";
      name: string;
      error: Extract<ImageStageRun, { ok: false }>["error"];
    };

/** One entry of a document's overflow menu. */
export type MoreAction = {
  key: string;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  testId?: string;
};

/**
 * "More actions" for a document: the secondary and destructive ones (Discard
 * changes, Delete document), kept out of the way of the primary action.
 * A menu item only opens its dialog; the dialog lives outside the menu.
 */
export function DocumentMoreMenu({ actions }: { actions: readonly MoreAction[] }) {
  const { t } = useTranslation("kb");
  if (actions.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="touch"
            data-testid="document-more"
            aria-label={t("document.moreActions")}
          />
        }
      >
        <MoreHorizontal aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {actions.map((action) => (
          <DropdownMenuItem
            key={action.key}
            className="min-h-[44px]"
            variant={action.destructive ? "destructive" : "default"}
            disabled={action.disabled}
            data-testid={action.testId}
            onClick={action.onSelect}
          >
            {action.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  // NFC as well: the server takes composed paths only, and it is the same text.
  return isNew ? path.trim().normalize("NFC") : path;
}

/** Both pane headers: one height, so the two boxes start on the same line. */
const PANE_HEADER = "flex h-6 items-center text-sm font-medium";
/** Both pane boxes: the grid row stretches them, so they also end together. */
const PANE_BOX = "min-h-[60svh] min-w-0 flex-1";

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
      className={cn("flex min-w-0 flex-col gap-2", hidden && "hidden lg:flex")}
    >
      <h3 id={headingId} className={PANE_HEADER}>
        {t("editor.previewLabel")}
      </h3>
      <div className={cn(PANE_BOX, "overflow-x-hidden rounded-md border bg-card p-4")}>
        <MarkdownView markdown={deferred} context={context} />
      </div>
    </section>
  );
}

/**
 * Where inserted images go in `text` (the shown body): the selection of a
 * textarea the user has focused, else the end of the draft. A never-focused
 * textarea reports a caret at 0, which would glue the image onto the first
 * line. A textarea counts each CRLF as one character (its value is
 * LF-normalized) while the draft keeps the bytes it was given, so its
 * offsets are mapped back onto `text`.
 */
export function imageInsertAt(
  focused: { selectionStart: number; selectionEnd: number } | null,
  text: string,
): { start: number; end: number } {
  if (!focused) return { start: text.length, end: text.length };
  return {
    start: textOffset(text, focused.selectionStart),
    end: textOffset(text, focused.selectionEnd),
  };
}

/** The index in `text` of a textarea offset that counts CRLF as one. */
function textOffset(text: string, shown: number): number {
  let index = 0;
  for (let seen = 0; seen < shown && index < text.length; seen += 1) {
    index += text[index] === "\r" && text[index + 1] === "\n" ? 2 : 1;
  }
  return index;
}

export function DocumentEditorView(props: DocumentEditorViewProps) {
  const { t } = useTranslation(["kb", "common"]);
  const textareaId = useId();
  const pathId = useId();
  const pathHintId = useId();
  const pathErrorId = useId();
  const saveStatusId = useId();
  const imageHintId = useId();
  const contentErrorId = useId();
  const pathRef = useRef<HTMLInputElement>(null);
  // The path rule is shown once the field was left or a save was tried.
  const [pathChecked, setPathChecked] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
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
  // textarea reports 0, which would glue an image onto the first line.
  const [touched, setTouched] = useState(false);
  // The app's provenance-only front matter is not shown: the chip says it
  // and the server stamps it on every save. The draft keeps the exact bytes.
  const { stamp, body } = splitProvenanceStamp(props.markdown);
  const selection = () => {
    const shown = imageInsertAt(touched ? textarea : null, body);
    return { start: shown.start + stamp.length, end: shown.end + stamp.length };
  };
  // A new document's path: the server's own rule, before any save is sent;
  // a refusal naming the path (e.g. it already exists) shows here as well.
  const typedPath = submitPath(props.path, props.isNew);
  const localPathIssue = props.isNew ? documentPathIssue(typedPath) : null;
  // A refusal of the path stands until the path is changed.
  const [pathEditedAfter, setPathEditedAfter] = useState<EditorOutcome | null>(null);
  const refusedPath =
    outcome?.kind === "error" && outcome.pathIssue && props.isNew && pathEditedAfter !== outcome
      ? outcome.pathIssue
      : null;
  const pathIssue = (pathChecked && localPathIssue) || refusedPath;
  // A refused content rule is the Markdown field's own error.
  const contentIssue = outcome?.kind === "error" ? outcome.contentIssue : undefined;
  const textareaDescribedBy =
    [contentIssue ? contentErrorId : null, image ? imageHintId : null].filter(Boolean).join(" ") ||
    undefined;
  const save = () => {
    if (localPathIssue) {
      setPathChecked(true);
      pathRef.current?.focus();
      return;
    }
    props.onSave();
  };
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
        <div role="status" className="rounded-md border p-3 text-sm [&_p]:max-w-prose">
          <p>{t("kb:editor.oldRevision", { sha: short(viewingRevision) })}</p>
          {props.onOpenLatest && (
            <Button variant="outline" className="mt-2 min-h-[44px]" onClick={props.onOpenLatest}>
              {t("kb:editor.openLatest")}
            </Button>
          )}
        </div>
      )}
      {editable && controls.editMode === "proposal" && (
        <p className="max-w-prose text-sm text-muted-foreground">{t("kb:editor.proposalNote")}</p>
      )}
      {viewingRevision === null && controls.editMode === "none" && (
        <p className="max-w-prose text-sm text-muted-foreground">{t("kb:editor.readOnlyNote")}</p>
      )}
      {props.isNew && editable ? (
        <div className="min-w-0 space-y-2">
          <Label htmlFor={pathId}>{t("kb:editor.pathLabel")}</Label>
          <Input
            ref={pathRef}
            id={pathId}
            data-testid="editor-path"
            value={props.path}
            readOnly={props.pathLocked}
            onChange={(e) => {
              setPathEditedAfter(outcome);
              props.onPathChange(e.target.value);
            }}
            onBlur={() => {
              if (props.path.trim() !== "") setPathChecked(true);
            }}
            autoComplete="off"
            inputMode="url"
            maxLength={512}
            placeholder={t("kb:editor.pathPlaceholder")}
            aria-invalid={pathIssue ? true : undefined}
            aria-describedby={pathIssue ? `${pathErrorId} ${pathHintId}` : pathHintId}
          />
          {pathIssue && (
            <p
              id={pathErrorId}
              data-testid="editor-path-error"
              className="text-sm text-destructive"
            >
              {t(`kb:editor.pathIssue.${pathIssue}`)}
            </p>
          )}
          <p id={pathHintId} className="text-xs text-muted-foreground">
            {t("kb:editor.pathHint")}
          </p>
        </div>
      ) : props.showPath !== false ? (
        <p className="truncate font-mono text-sm">{props.path}</p>
      ) : null}
      {editable && (
        // One toolbar over both panes, so the two panes start on the same line.
        <div
          data-testid="editor-toolbar"
          className="flex min-w-0 flex-wrap items-center justify-between gap-2"
        >
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
          {image && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
              <Button
                type="button"
                variant="outline"
                size="touch"
                data-testid="editor-insert-image"
                disabled={props.pending}
                aria-describedby={imageHintId}
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
              <p id={imageHintId} className="min-w-0 text-xs text-muted-foreground">
                {t("kb:editor.image.hint")}
              </p>
            </div>
          )}
        </div>
      )}
      {image?.status && <ImageStatusLine status={image.status} />}
      <div className={editable ? "grid min-w-0 gap-4 lg:grid-cols-2" : "min-w-0"}>
        <div
          className={cn(
            "flex min-w-0 flex-col gap-2",
            editable && pane !== "write" && "hidden lg:flex",
          )}
        >
          <Label htmlFor={textareaId} className={PANE_HEADER}>
            {t("kb:editor.markdownLabel")}
          </Label>
          {/* Raw Markdown editor: the bytes saved are exactly what is typed here
              (the app's own provenance stamp aside, which the server writes). */}
          <Textarea
            ref={setTextarea}
            id={textareaId}
            data-testid="editor-markdown"
            value={body}
            onChange={(e) => props.onMarkdownChange(joinProvenanceStamp(stamp, e.target.value))}
            readOnly={!editable}
            spellCheck
            aria-invalid={contentIssue ? true : undefined}
            aria-describedby={textareaDescribedBy}
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
              PANE_BOX,
              "resize-none font-mono text-sm leading-relaxed",
              dragging && "border-primary ring-2 ring-ring",
            )}
          />
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
      {/* Below both panes, so their boxes keep ending on one line; the
          textarea still names it (`aria-describedby`). */}
      {contentIssue && (
        <p
          id={contentErrorId}
          role="alert"
          data-testid="editor-content-error"
          className="text-sm text-destructive"
        >
          {t(`kb:editor.contentIssue.${contentIssue}`)}
        </p>
      )}
      {props.paused && (
        <p role="status" className="text-sm">
          {t("kb:editor.offline")}
        </p>
      )}
      {outcome &&
        !(outcome.kind === "error" && ((outcome.pathIssue && props.isNew) || contentIssue)) && (
          <EditorOutcomeNotice {...props} outcome={outcome} />
        )}
      {editable && (
        // Save and its state stay in view while a long draft scrolls.
        <div
          data-testid="editor-save-bar"
          className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center gap-x-3 gap-y-2 border-t bg-background/95 px-1 py-3 supports-[backdrop-filter]:bg-background/80 supports-[backdrop-filter]:backdrop-blur"
        >
          <Button
            data-testid="editor-save"
            className="min-h-[44px]"
            disabled={props.pending}
            aria-describedby={saveStatusId}
            onClick={save}
          >
            {props.pending ? t("kb:editor.saving") : saveLabel}
          </Button>
          <span
            id={saveStatusId}
            role="status"
            data-testid="editor-save-status"
            data-dirty={props.dirty ? "true" : "false"}
            data-base-revision={props.baseRevision}
            // The revision a save writes against, for whoever needs it.
            title={t("kb:editor.baseRevision", { sha: short(props.baseRevision) })}
            className={cn(
              "text-sm",
              props.dirty
                ? "font-medium text-amber-700 dark:text-amber-400"
                : "text-muted-foreground",
            )}
          >
            {props.pending
              ? t("kb:editor.saving")
              : props.dirty
                ? t("kb:editor.unsaved")
                : outcome?.kind === "applied" || outcome?.kind === "noop"
                  ? t("kb:editor.saved")
                  : outcome?.kind === "proposed"
                    ? t("kb:editor.proposedStatus", { number: outcome.proposalNumber })
                    : t("kb:editor.noChanges")}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {props.doneAction}
            <DocumentMoreMenu
              actions={[
                ...(props.dirty && props.onDiscard && !props.pending
                  ? [
                      {
                        key: "discard",
                        label: t("kb:editor.discard"),
                        testId: "editor-discard",
                        onSelect: () => setConfirmDiscard(true),
                      },
                    ]
                  : []),
                ...(props.moreActions ?? []),
              ]}
            />
          </div>
        </div>
      )}
      {props.onDiscard && (
        <ConfirmActionDialog
          open={confirmDiscard}
          onOpenChange={setConfirmDiscard}
          title={t("kb:editor.discardTitle")}
          description={t("kb:editor.discardDescription")}
          confirmLabel={t("kb:editor.discard")}
          destructive
          onConfirm={() => {
            setConfirmDiscard(false);
            props.onDiscard?.();
          }}
        />
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
  const box = "min-w-0 space-y-2 rounded-md border p-3 text-sm [&_p]:max-w-prose";
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
          {outcome.pathIssue
            ? t(`editor.pathIssue.${outcome.pathIssue}`)
            : t(outcome.reason === "unknown" ? "editor.error" : `editor.${outcome.reason}`, {
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
 * Inserts dropped, pasted or chosen images into the draft. Each
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
  draft: snapshot,
  onPending,
}: {
  files: readonly F[];
  at: { start: number; end: number };
  /** The text the selection covered, restored if nothing gets inserted. */
  selected: string;
  /** The draft as the files arrived (what `at` and `selected` refer to). */
  draft?: string;
  /** The placeholder block while uploads are pending, then null (kept drafts store around it). */
  onPending?: (pending: PendingUpload | null) => void;
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
  if (snapshot !== undefined && onPending) {
    const from = Math.min(at.start, snapshot.length);
    const to = Math.min(Math.max(at.end, from), snapshot.length);
    const { lead, trail } = paragraphBreaks(snapshot.slice(0, from), snapshot.slice(to));
    onPending({ inserted: lead + tokens.join(separator) + trail, selected });
  }
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
  try {
    await uploadEach();
  } finally {
    onPending?.(null);
  }
  async function uploadEach() {
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
  /** See `DocumentEditorViewProps.doneAction` and `.moreActions`. */
  doneAction?: ReactNode;
  moreActions?: readonly MoreAction[];
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
  doneAction,
  moreActions,
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
        draft: editor.markdown,
        onPending: editor.setPendingUpload,
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
      // After a save the preview reads the revision it produced.
      preview={effectivePreview}
      stagedImages={editor.stagedImages}
      dirty={editor.dirty}
      onDiscard={editor.discard}
      doneAction={doneAction}
      moreActions={moreActions}
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
 * Delete document: the confirmation behind the document's "Delete document"
 * menu action (`open` is the page's; the menu only opens it). It sends the
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
  open,
  onOpenChange: setOpen,
  onDeleted,
}: {
  lang: string;
  kbId: string;
  editor: KbEditorSession;
  proposing?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Deleted on main. `undo` names the revision whose version was deleted
   * (the delete's own base, which the server confirmed unchanged) and the
   * head the delete wrote; null when it was already gone (noop).
   */
  onDeleted: (undo: { revision: string; head: string } | null) => void;
}) {
  const { t } = useTranslation(["kb", "common"]);
  // The session's own document: the one its delete record names.
  const { path } = editor;
  const queryClient = useQueryClient();
  const [stale, setStale] = useState<StaleDelete | null>(null);
  const head = useRevisionRead(kbId, path, stale?.headSha ?? null);
  const send = async (rebase?: StaleDelete) => {
    setOpen(false);
    const run = await editor.deleteDocument(rebase);
    // A retired page (another KB opened meanwhile) gets no outcome.
    if (!run) return;
    const { outcome, deletedFrom } = run;
    setStale(null);
    switch (outcome.kind) {
      case "applied":
        onDeleted(deletedFrom ? { revision: deletedFrom, head: outcome.commitSha } : null);
        return;
      case "noop":
        onDeleted(null);
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
  );
}

type ProposalModeKb = EditorKb;

/**
 * PR mode: edit a document as the viewer's pull request has it. The
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
  draftOwner,
  onLeave,
}: {
  lang: string;
  kb: ProposalModeKb;
  number: number;
  path: string;
  /** The signed-in person's actor key: unsaved drafts are theirs only (null: none kept). */
  draftOwner: string | null;
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
  const box = "min-w-0 space-y-2 rounded-md border p-3 text-sm [&_p]:max-w-prose";
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
      draftOwner={draftOwner}
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
  draftOwner,
}: {
  lang: string;
  kb: ProposalModeKb;
  number: number;
  path: string;
  draftOwner: string | null;
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
  const box = "min-w-0 space-y-2 rounded-md border p-3 text-sm [&_p]:max-w-prose";
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
      draftOwner={draftOwner}
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
  draftOwner,
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
  draftOwner: string | null;
}) {
  const { t } = useTranslation("kb");
  // Unsaved work kept in this tab (the signed-in person's own). A recovered
  // draft writes against the main and PR heads it was written on, so a PR
  // or main that moved since is a conflict, never an overwrite.
  const [key] = useState(() =>
    draftOwner === null
      ? null
      : draftKey({ userId: draftOwner, kbId: kb.id, path, proposal: number, resolving: true }),
  );
  const [recovered] = useState<StoredDraft | null>(() => {
    const stored = key ? readDraft(key) : null;
    return stored && stored.markdown !== (source?.markdown ?? "") ? stored : null;
  });
  // Writes go against main with the PR named at the head PR mode read.
  const editor = useKbEditor({
    target: { kbId: kb.id, path, target: { kind: "proposal", number } },
    initialMarkdown: source?.markdown ?? "",
    baseRevision: recovered?.base ?? mainSha,
    proposalHead: recovered?.proposalHead ?? prHeadSha,
    initialExists: !deleted,
    recovered: recovered
      ? { markdown: recovered.markdown, images: recovered.images ?? [] }
      : undefined,
  });
  useDocumentDraft({
    key,
    dirty: editor.dirty,
    pending: editor.pending,
    markdown: editor.markdown,
    base: editor.baseRevision,
    proposalHead: editor.proposalHead ?? undefined,
    images: editor.stagedImages,
    pendingUpload: editor.pendingUpload,
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
        className="min-w-0 space-y-2 rounded-md border border-primary/40 p-3 text-sm [&_p]:max-w-prose"
      >
        <p className="font-medium">{t("prMode.title", { number })}</p>
        <p>{t("prMode.body")}</p>
        {recovered && editor.dirty && (
          <p data-testid="pr-mode-draft-recovered">
            {t("draft.recovered", {
              time: new Date(recovered.savedAt).toLocaleTimeString(lang, {
                hour: "numeric",
                minute: "2-digit",
              }),
            })}
          </p>
        )}
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
          // Leaving PR mode is in the editor bar too, next to Save.
          doneAction={leave}
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
