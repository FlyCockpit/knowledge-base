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
import type * as React from "react";
import { useTranslation } from "react-i18next";

/**
 * Confirmation for a consequential one-click action that is not a delete
 * (R2-7): promoting an admin, archiving a user, changing an instance policy,
 * dropping your own Manage. Deletes keep `ConfirmDeleteDialog` (type-to-confirm).
 */
export function ConfirmActionDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel,
  pendingLabel,
  isPending = false,
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  /** Extra detail between the description and the actions. */
  children?: React.ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  isPending?: boolean;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("common");
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-[calc(100%-2rem)]! sm:max-w-md! data-[size=default]:max-w-[calc(100%-2rem)]! data-[size=default]:sm:max-w-md!">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter className="sm:flex-wrap">
          <AlertDialogCancel className="min-h-[44px] w-full sm:w-auto">
            {t("actions.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            className="min-h-[44px] w-full sm:w-auto"
            disabled={isPending}
            onClick={onConfirm}
          >
            {isPending && pendingLabel ? pendingLabel : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
