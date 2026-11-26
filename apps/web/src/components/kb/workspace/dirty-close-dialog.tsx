import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@knowledge-base/ui/components/alert-dialog";
import { Button } from "@knowledge-base/ui/components/button";
import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Closing a tab with unsaved changes: Save (then close), Discard (close and
 * drop the changes) or Cancel (keep it open). Nothing closes while a save is
 * running, and a failed save keeps the tab and its draft.
 */
export function DirtyCloseDialog({
  name,
  open,
  canSave,
  busy = false,
  onSave,
  onDiscard,
  onCancel,
}: {
  /** The file's name, as on its tab. */
  name: string;
  open: boolean;
  /** False when this draft cannot be saved now (read-only, invalid, …): Discard or Cancel only. */
  canSave: boolean;
  /**
   * A save of this file started elsewhere (⌘S, its Save bar) is still running:
   * nothing is decided until it settles, so Discard can't race it.
   */
  busy?: boolean;
  /** Resolves true once saved; the caller then closes the tab. */
  onSave: () => Promise<boolean>;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("kb");
  const [ownSave, setSaving] = useState(false);
  const saving = ownSave || busy;
  const save = async () => {
    setSaving(true);
    try {
      await onSave();
    } finally {
      setSaving(false);
    }
  };
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next, details) => {
        // Only Escape (or Cancel) answers it. Focus moving away — the file's
        // editor mounting behind it — is not an answer and keeps the question.
        // Never blocked: a question can always be put aside.
        if (!next && details.reason === "escape-key") onCancel();
      }}
    >
      <AlertDialogContent data-testid="kb-dirty-close">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("workspace.dirtyClose.title", { name })}</AlertDialogTitle>
          <AlertDialogDescription>{t("workspace.dirtyClose.description")}</AlertDialogDescription>
        </AlertDialogHeader>
        <DirtyCloseActions
          canSave={canSave}
          saving={saving}
          onSave={() => void save()}
          onDiscard={onDiscard}
          onCancel={onCancel}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The dialog's buttons and the reason Save is unavailable (exported for tests). */
export function DirtyCloseActions({
  canSave,
  saving,
  onSave,
  onDiscard,
  onCancel,
}: {
  canSave: boolean;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation("kb");
  const reasonId = useId();
  return (
    <>
      {!canSave && (
        <p id={reasonId} className="text-xs text-muted-foreground">
          {t("workspace.dirtyClose.cannotSave")}
        </p>
      )}
      <AlertDialogFooter>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 w-full sm:w-auto"
          onClick={onCancel}
          data-testid="dirty-close-cancel"
        >
          {t("workspace.dirtyClose.cancel")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          className="min-h-11 w-full sm:w-auto"
          disabled={saving}
          onClick={onDiscard}
          data-testid="dirty-close-discard"
        >
          {t("workspace.dirtyClose.discard")}
        </Button>
        <Button
          type="button"
          className="min-h-11 w-full sm:w-auto"
          disabled={!canSave || saving}
          aria-describedby={canSave ? undefined : reasonId}
          onClick={onSave}
          data-testid="dirty-close-save"
        >
          {saving && <Loader2 aria-hidden className="size-4 animate-spin" />}
          {t(saving ? "workspace.dirtyClose.saving" : "workspace.dirtyClose.save")}
        </Button>
      </AlertDialogFooter>
    </>
  );
}
