import { toast } from "@knowledge-base/ui/components/sileo";

/**
 * How long the "User archived" toast (and its Undo) stays up. Longer than a
 * plain success toast: the admin has to notice it and reach the button.
 */
export const ARCHIVE_UNDO_TOAST_MS = 8_000;

/**
 * Archiving a user (after its confirm dialog) can be undone for sign-in: the
 * success toast carries an Undo that restores the account right away. Undo
 * calls the same `users.unarchive` as the row's "Restore user" action, so,
 * like it, it lifts the ban only: the access tokens and connected apps that
 * archive revoked stay revoked (the confirm dialog says so).
 */
export function announceArchivedWithUndo({
  message,
  undoLabel,
  onUndo,
}: {
  message: string;
  undoLabel: string;
  onUndo: () => void;
}): string {
  return toast.success(message, {
    duration: ARCHIVE_UNDO_TOAST_MS,
    action: { label: undoLabel, onClick: onUndo },
  });
}
