import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@knowledge-base/ui/components/alert-dialog";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { Input } from "@knowledge-base/ui/components/input";
import { Label } from "@knowledge-base/ui/components/label";
import type * as React from "react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

type ConfirmDeleteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  /** Shown between the description and the typed confirmation (e.g. what is deleted). */
  children?: React.ReactNode;
  /** Verbatim string the admin must type to enable the destructive action. */
  confirmToken: string;
  /** Label rendered above the typed input, e.g. "Type the user's email to confirm". */
  typePrompt: string;
  /** aria-label for the copy-to-clipboard button (i18n owns this string). */
  copyAriaLabel: string;
  /** Defaults to confirmToken. */
  placeholder?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  /** Defaults to t("common:actions.delete"). */
  confirmLabel?: string;
  /** Defaults to t("common:actions.deleting"). */
  pendingLabel?: string;
  isPending?: boolean;
  /** Extra disable signal OR'd with the built-in checks (e.g. count === 0 for bulk). */
  disabled?: boolean;
  /**
   * Called with the operator's *typed* value (guaranteed === confirmToken,
   * since the action is disabled until they match). Pass it through to the
   * server so the confirmation reflects deliberate keystrokes rather than a
   * value the client copied back from its own fetched state.
   */
  onConfirm: (confirmValue: string) => void;
};

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmToken,
  typePrompt,
  copyAriaLabel,
  placeholder,
  inputMode,
  confirmLabel,
  pendingLabel,
  isPending = false,
  disabled = false,
  onConfirm,
  children,
}: ConfirmDeleteDialogProps) {
  const [confirm, setConfirm] = useState("");
  const inputId = useId();
  const { t } = useTranslation("common");

  const handleOpenChange = (next: boolean) => {
    if (!next) setConfirm("");
    onOpenChange(next);
  };

  const matches = confirm === confirmToken && confirmToken.length > 0;
  const actionDisabled = !matches || isPending || disabled;

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      {/*
        Confirm-delete dialogs carry a typed token + two touch-sized actions.
        The default alert max-width (xs/sm) is too narrow for the footer on
        small screens, so override both base and data-[size=…] variants.
      */}
      <AlertDialogContent className="max-w-[calc(100%-2rem)]! sm:max-w-md! data-[size=default]:max-w-[calc(100%-2rem)]! data-[size=default]:sm:max-w-md! data-[size=sm]:max-w-[calc(100%-2rem)]!">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <div className="min-w-0 space-y-2">
          <Label htmlFor={inputId}>{typePrompt}</Label>
          <CopyField value={confirmToken} copyLabel={copyAriaLabel} />
          <Input
            id={inputId}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={placeholder ?? confirmToken}
            autoComplete="off"
            inputMode={inputMode}
          />
        </div>
        <AlertDialogFooter className="sm:flex-wrap">
          <AlertDialogCancel className="min-h-[44px] w-full sm:w-auto">
            {t("actions.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className="min-h-[44px] w-full sm:w-auto"
            disabled={actionDisabled}
            onClick={() => onConfirm(confirm)}
          >
            {isPending
              ? (pendingLabel ?? t("actions.deleting"))
              : (confirmLabel ?? t("actions.delete"))}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
