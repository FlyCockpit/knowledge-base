import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import { FIRST_INVALID_SELECTOR } from "@knowledge-base/ui/lib/focus-first-invalid";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";

import { MAIN_SCROLLER_SELECTOR } from "@/lib/main-scroller";

/**
 * Shared pieces of the token and API-key create pages: the back link, the
 * action bar's contents, and the problems that show next to the part of the
 * form they are about once Create is pressed.
 * See docs/ui.md § Form surfaces
 */

/** Where a create page goes back to: the settings page that lists what it creates. */
export type CredentialListPath = "/$lang/settings/mcp" | "/$lang/settings/api-keys";

/** The pinned title row's back link. */
export function BackLink({ to, lang }: { to: CredentialListPath; lang: string }) {
  const { t } = useTranslation("common");
  return (
    <Link to={to} params={{ lang }} className={buttonVariants({ variant: "ghost", size: "touch" })}>
      <ArrowLeft aria-hidden="true" className="size-4" />
      {t("actions.back")}
    </Link>
  );
}

/**
 * The action bar's contents: one line saying what Create will do (or the
 * first thing still missing), then Cancel and Create. Create stays enabled
 * while something is missing, so pressing it shows each problem next to its
 * field; it is disabled only while creating or after an uncertain attempt.
 * A failed attempt (offline, rejected, uncertain) shows its `alert` there
 * instead of the note, so the message is on screen right where Create was
 * pressed, however far the page is scrolled.
 */
export function CreateActions({
  reasons,
  summary,
  pending,
  blocked,
  submitLabel,
  pendingLabel,
  cancelTo,
  lang,
  alert,
}: {
  /** What is still missing, in the order the form asks; empty when it can be created. */
  reasons: readonly string[];
  /** What Create will make, shown once nothing is missing. */
  summary: string;
  pending: boolean;
  /** Disabled for another reason (an uncertain earlier attempt); its message shows in the form. */
  blocked: boolean;
  submitLabel: string;
  pendingLabel: string;
  cancelTo: CredentialListPath;
  lang: string;
  /** Why the last attempt did not create anything (or may have); replaces the note. */
  alert?: string;
}) {
  const { t } = useTranslation("common");
  const noteId = useId();
  const note = pending ? undefined : (reasons[0] ?? summary);
  const describedBy = alert || note ? noteId : undefined;
  return (
    <>
      {alert ? (
        <p
          id={noteId}
          role="alert"
          data-testid="create-alert"
          className="min-w-0 basis-full text-sm text-destructive sm:flex-1 sm:basis-0"
        >
          {alert}
        </p>
      ) : note ? (
        // Its own line above the buttons on a phone, left of them otherwise.
        <p
          id={noteId}
          role="status"
          data-testid="create-note"
          className="min-w-0 basis-full text-sm text-muted-foreground sm:flex-1 sm:basis-0"
        >
          {note}
        </p>
      ) : null}
      <Link
        to={cancelTo}
        params={{ lang }}
        className={buttonVariants({ variant: "outline", size: "touch" })}
      >
        {t("actions.cancel")}
      </Link>
      <Button
        type="submit"
        size="touch"
        disabled={pending || blocked}
        aria-describedby={describedBy}
      >
        {pending ? pendingLabel : submitLabel}
      </Button>
    </>
  );
}

/**
 * A problem with one part of the form, shown right under it after Create was
 * pressed. Focusable (not tabbable), so the first one can take focus.
 */
export function FormIssue({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p data-form-issue tabIndex={-1} role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}

/** An invalid field, or a problem shown under a part of the form. */
export const FIRST_PROBLEM_SELECTOR = `${FIRST_INVALID_SELECTOR}, [data-form-issue]`;

/**
 * Focus the first problem in the form, in document order (an invalid field
 * or a `FormIssue`), after React has committed them. A closed Advanced
 * section around it is opened first.
 */
export function focusFirstProblem(
  root: Pick<ParentNode, "querySelector"> | null | undefined,
  schedule: (callback: () => void) => unknown = (callback) => requestAnimationFrame(callback),
): void {
  if (!root) return;
  schedule(() => {
    const target = root.querySelector<HTMLElement>(FIRST_PROBLEM_SELECTOR);
    if (!target) return;
    for (let details = target.closest?.("details"); details; ) {
      details.open = true;
      details = details.parentElement?.closest("details") ?? null;
    }
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "center", inline: "nearest" });
  });
}

/**
 * After a mint the page swaps the form for the one-time secret: bring the
 * page scroller to the top so its "copy it now" warning is what shows first,
 * not wherever the Create button was.
 */
export function scrollPageToTop(root: Pick<ParentNode, "querySelector"> = document): void {
  root.querySelector<HTMLElement>(MAIN_SCROLLER_SELECTOR)?.scrollTo({ top: 0 });
}
