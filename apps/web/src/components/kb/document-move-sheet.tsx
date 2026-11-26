import {
  isKbNamespacePath,
  isMarkdownPath,
  normalizeKbPath,
} from "@knowledge-base/api/lib/kb/paths";
import { Button } from "@knowledge-base/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@knowledge-base/ui/components/sheet";
import { toast } from "@knowledge-base/ui/components/sileo";
import { TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { KbEditorSession, MoreAction } from "@/components/kb/document-editor";
import {
  confirmableConflict,
  type DocumentPathRefusal,
  type EditorOutcome,
} from "@/hooks/use-kb-editor";
import { orpc } from "@/utils/orpc";

/** The `kb:move.error.*` key for a refused target path. */
type MoveFieldError =
  | "empty"
  | "invalid"
  | "reserved"
  | "notMarkdown"
  | "same"
  | "exists"
  | "caseCollision"
  | "relativeLinks"
  | "sourceGone";

/**
 * Client-side check of the server's path rules (`normalizeKbPath`, the KB
 * namespace, `.md` only): the cheap ones, so most mistakes are named before
 * anything is sent. The server checks everything again.
 */
export function moveTargetError(current: string, raw: string): MoveFieldError | null {
  if (raw.length === 0) return "empty";
  const normalized = normalizeKbPath(raw);
  if (!normalized.ok) return "invalid";
  if (isKbNamespacePath(normalized.path)) return "reserved";
  if (!isMarkdownPath(normalized.path)) return "notMarkdown";
  if (normalized.path === current) return "same";
  return null;
}

const REFUSAL_ERROR: Record<DocumentPathRefusal, MoveFieldError> = {
  PATH_EXISTS: "exists",
  INVALID_PATH: "invalid",
  RESERVED_PATH: "reserved",
  PATH_CASE_COLLISION: "caseCollision",
  PATH_NOT_FOUND: "sourceGone",
  NOT_MARKDOWN_PATH: "notMarkdown",
  MOVE_BREAKS_ASSET_LINKS: "relativeLinks",
};

type StaleMove = { headSha: string; proposalNumber: number | null };

/**
 * The "Rename or move" entry of a document's More actions menu: one Git
 * rename commit (a pull request update when proposing). Unavailable while a
 * save is in flight.
 */
export function documentMoveAction(
  t: (key: string) => string,
  pending: boolean,
  onSelect: () => void,
): MoreAction {
  return {
    key: "move",
    label: t("move.action"),
    disabled: pending,
    testId: "document-move",
    onSelect,
  };
}

/**
 * What the sheet does with a move's outcome. A receipt closes it (the
 * session's new path navigates the page there); a refused path is named under
 * the field; a moved head is asked about once more; anything else is a
 * notice, with the sheet and the typed path kept.
 */
type MoveOutcomePlan =
  | { kind: "done"; proposal: { number: number; created: boolean } | null }
  | { kind: "field"; error: MoveFieldError }
  | { kind: "stale"; stale: StaleMove | null }
  | { kind: "notice"; outcome: Extract<EditorOutcome, { kind: "error" | "retryable" }> };

export function moveOutcomePlan(outcome: EditorOutcome, from: string): MoveOutcomePlan {
  switch (outcome.kind) {
    case "applied":
    case "noop":
      return { kind: "done", proposal: null };
    case "proposed":
      return {
        kind: "done",
        proposal: { number: outcome.proposalNumber, created: outcome.created },
      };
    case "conflict":
      return {
        kind: "stale",
        stale: confirmableConflict(outcome, { kind: "document", path: from }),
      };
    case "error":
      return outcome.path
        ? { kind: "field", error: REFUSAL_ERROR[outcome.path] }
        : { kind: "notice", outcome };
    case "retryable":
      return { kind: "notice", outcome };
  }
}

export function DocumentMoveSheet({
  editor,
  proposing,
  onOpenChange,
  initialToPath,
}: {
  editor: KbEditorSession;
  proposing: boolean;
  onOpenChange: (open: boolean) => void;
  /** The target typed in already (the workspace tree's rename or drag-to-move). */
  initialToPath?: string;
}) {
  const { t } = useTranslation(["kb", "common"]);
  const queryClient = useQueryClient();
  // The document this sheet moves: the session's path when it opened.
  const [from] = useState(editor.path);
  const [serverError, setServerError] = useState<MoveFieldError | null>(null);
  // The last outcome that left the sheet open, and the head a resend confirms.
  const [notice, setNotice] = useState<MoveOutcomePlan | null>(null);
  const [stale, setStale] = useState<StaleMove | null>(null);
  const settle = (outcome: EditorOutcome, toPath: string) => {
    const plan = moveOutcomePlan(outcome, from);
    switch (plan.kind) {
      case "done":
        toast.success(
          plan.proposal === null
            ? t("kb:move.moved", { path: toPath })
            : t(
                plan.proposal.created
                  ? "kb:outcome.proposalCreatedTitle"
                  : "kb:outcome.proposedTitle",
                {
                  number: plan.proposal.number,
                },
              ),
        );
        onOpenChange(false);
        return;
      case "field":
        setServerError(plan.error);
        return;
      case "stale":
        // The page's own view re-reads in the background.
        void queryClient.invalidateQueries({ queryKey: orpc.documents.key() });
        setStale(plan.stale);
        setNotice(plan);
        return;
      case "notice":
        setNotice(plan);
    }
  };
  const form = useForm({
    defaultValues: { toPath: initialToPath ?? from },
    onSubmit: async ({ value }) => {
      setNotice(null);
      const rebase = stale ?? undefined;
      setStale(null);
      const outcome = await editor.submit({ kind: "move", toPath: value.toPath }, rebase);
      // A retired page (another document opened meanwhile) gets no outcome.
      if (outcome) settle(outcome, value.toPath);
    },
  });
  const noticeText =
    notice === null
      ? null
      : notice.kind === "stale"
        ? stale
          ? t("kb:move.stale", { sha: stale.headSha.slice(0, 12) })
          : t("kb:outcome.conflictUnknown")
        : notice.kind === "notice"
          ? notice.outcome.kind === "retryable"
            ? t("kb:editor.retryable")
            : t(
                notice.outcome.reason === "unknown"
                  ? "kb:editor.error"
                  : `kb:editor.${notice.outcome.reason}`,
              )
          : null;
  return (
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>{t("kb:move.title")}</SheetTitle>
          <SheetDescription className="break-all">
            {t("kb:move.description", { path: from })}
          </SheetDescription>
        </SheetHeader>
        <form
          className="min-w-0 space-y-4 px-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            void form.handleSubmit();
          }}
        >
          <form.Field
            name="toPath"
            validators={{
              onSubmit: ({ value }) => {
                const error = moveTargetError(from, value);
                return error ? t(`kb:move.error.${error}`) : undefined;
              },
            }}
            listeners={{ onChange: () => setServerError(null) }}
          >
            {(field) => (
              <TextField
                field={{
                  ...field,
                  state: {
                    ...field.state,
                    meta: {
                      errors: [
                        ...field.state.meta.errors,
                        ...(serverError ? [t(`kb:move.error.${serverError}`)] : []),
                      ],
                    },
                  },
                }}
                label={t("kb:move.pathLabel")}
                description={t(proposing ? "kb:move.hintProposal" : "kb:move.hint")}
                autoComplete="off"
                inputMode="text"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={512}
                inputClassName="font-mono"
              />
            )}
          </form.Field>
          {editor.paused && (
            <p role="status" className="text-sm">
              {t("kb:editor.offline")}
            </p>
          )}
          {noticeText && (
            <p role="alert" className="text-sm text-destructive">
              {noticeText}
            </p>
          )}
          <SheetFooter className="px-0">
            <Button type="submit" className="min-h-[44px]" disabled={editor.pending}>
              {editor.pending ? t("kb:editor.saving") : t("kb:move.submit")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
