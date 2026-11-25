import { Button } from "@knowledge-base/ui/components/button";
import { DialogFooter } from "@knowledge-base/ui/components/dialog";
import { ChevronDown } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Shared pieces of the token and API-key create dialogs: a collapsed
 * "Advanced" section and a footer that stays in view and says why Create is
 * disabled, right next to it.
 */

/** Options most people never need, closed until asked for (open when `defaultOpen`). */
export function AdvancedSection({
  label,
  defaultOpen = false,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="min-w-0 space-y-4">
      <Button
        type="button"
        variant="ghost"
        // Long (translated) labels wrap on a phone instead of running past the dialog.
        className="h-auto min-h-[44px] max-w-full justify-start px-2 text-left whitespace-normal"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown
          aria-hidden
          className={`size-4 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        />
        {label}
      </Button>
      {open && (
        <div id={id} className="min-w-0 space-y-6 border-l-2 pl-3">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Cancel and Create, pinned to the bottom of the scrolling dialog. While
 * Create is disabled, the first reason shows beside it and describes it.
 */
export function CreateFooter({
  reasons,
  pending,
  blocked,
  submitLabel,
  pendingLabel,
  onCancel,
}: {
  /** Why the draft can't be created yet, in the order the form asks; empty when it can. */
  reasons: readonly string[];
  pending: boolean;
  /** Disabled for another reason (an uncertain earlier attempt); its message shows in the form. */
  blocked: boolean;
  submitLabel: string;
  pendingLabel: string;
  onCancel: () => void;
}) {
  const { t } = useTranslation("common");
  const reasonId = useId();
  const reason = pending ? undefined : reasons[0];
  return (
    // Sticky to the dialog's bottom edge: `-bottom-4` cancels the dialog's p-4, which sticky
    // positioning keeps clear, so nothing scrolls past underneath. One row of buttons, also
    // on a phone, so the footer stays short.
    <DialogFooter className="sticky -bottom-4 z-10 -mx-4 -mb-4 flex-row flex-wrap items-center justify-end border-t bg-background p-4">
      {reason ? (
        // Its own line above the buttons on a phone, left of them otherwise.
        <p
          id={reasonId}
          role="status"
          className="min-w-0 basis-full text-sm text-muted-foreground sm:flex-1 sm:basis-0"
        >
          {reason}
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className="min-h-[44px] flex-1 sm:flex-none"
        onClick={onCancel}
      >
        {t("actions.cancel")}
      </Button>
      <Button
        type="submit"
        className="min-h-[44px] flex-1 sm:flex-none"
        disabled={pending || blocked || reasons.length > 0}
        aria-describedby={reason ? reasonId : undefined}
      >
        {pending ? pendingLabel : submitLabel}
      </Button>
    </DialogFooter>
  );
}
