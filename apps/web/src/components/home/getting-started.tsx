import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import { toast } from "@knowledge-base/ui/components/sileo";
import { cn } from "@knowledge-base/ui/lib/utils";
import { Link, type LinkProps } from "@tanstack/react-router";
import { ChevronRight, Circle, CircleCheck } from "lucide-react";
import { useId, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import {
  defaultGettingStartedExpanded,
  gettingStartedProgress,
  hideGettingStarted,
  isGettingStartedHidden,
  subscribeGettingStartedHidden,
} from "@/lib/getting-started";

/** What a step's button does: open something on the page, or go somewhere. */
type GettingStartedAction =
  | { label: string; onClick: () => void }
  | { label: string; link: LinkProps };

export type GettingStartedStep = {
  id: string;
  title: string;
  description?: string;
  /**
   * Detected from real data, never ticked by the user: a knowledge base
   * exists, an AI client is connected, a second account exists. The list can
   * only say what is true.
   */
  done: boolean;
  /** The next action, shown while the step is not done. */
  action: GettingStartedAction;
};

/**
 * Whether `scope` (the user id) hid the checklist, kept in step with Hide,
 * Undo and other tabs. The home reads it too, to skip the reads behind the
 * steps while the list is hidden.
 */
export function useGettingStartedHidden(scope: string): boolean {
  // One getter for both snapshots: the app branch is client-only, and on a
  // server (no `window`) it reads "not hidden" anyway.
  const readHidden = () => isGettingStartedHidden(scope);
  return useSyncExternalStore(subscribeGettingStartedHidden, readHidden, readHidden);
}

/**
 * The getting-started checklist of the signed-in home. Generic: the page
 * passes its own steps (lib/getting-started.ts holds the logic, and
 * `useAccountSetupSteps` the account step every user of a server shares).
 * docs/ui.md § The signed-in home.
 *
 * - "n of m done", and every open step shows its next action.
 * - Gone once every step is done, and hideable before that ("Hide", with an
 *   Undo toast). The hidden flag is per user (`scope` = the user id).
 * - A disclosure (`aria-expanded`): collapsed below `sm` to the title and the
 *   progress, so on a phone the main list stays on screen; expanded from
 *   `sm` up.
 *
 * Render it only once the data behind the steps has loaded: it has no
 * skeleton, so mounting it with guesses would show wrong ticks and then move
 * the page.
 */
export function GettingStarted({
  steps,
  scope,
  title,
}: {
  steps: readonly GettingStartedStep[];
  /** Whose checklist this is (the user id): the key of the hidden flag. */
  scope: string;
  /** Defaults to "Get started". */
  title?: string;
}) {
  const { t } = useTranslation("common");
  const hidden = useGettingStartedHidden(scope);
  const [expanded, setExpanded] = useState(defaultGettingStartedExpanded);
  const listId = useId();
  const progress = gettingStartedProgress(steps);

  if (hidden || progress.allDone) return null;

  const hide = () =>
    hideGettingStarted(scope, (undo) => {
      toast.message(t("gettingStarted.hidden"), {
        action: { label: t("gettingStarted.undo"), onClick: undo },
      });
    });

  return (
    <section
      aria-label={title ?? t("gettingStarted.title")}
      className="rounded-xl bg-card text-sm text-card-foreground ring-1 ring-foreground/10"
    >
      <div className="flex items-center gap-2 px-2 py-1">
        {/* The accordion pattern: the heading holds the disclosure button. */}
        <h2 className="min-w-0 flex-1">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((open) => !open)}
            className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-4 shrink-0 text-muted-foreground motion-safe:transition-transform",
                expanded && "rotate-90",
              )}
            />
            <span className="min-w-0">
              <span className="block truncate text-base font-medium">
                {title ?? t("gettingStarted.title")}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t("gettingStarted.progress", { done: progress.done, total: progress.total })}
              </span>
            </span>
          </button>
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="touch"
          className="shrink-0"
          aria-label={t("gettingStarted.hideAriaLabel")}
          onClick={hide}
        >
          {t("gettingStarted.hide")}
        </Button>
      </div>
      <div aria-hidden className="mx-4 mb-3 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }}
        />
      </div>
      <ol id={listId} hidden={!expanded} className="divide-y border-t">
        {steps.map((step) => (
          <li
            key={step.id}
            data-step={step.id}
            data-done={step.done ? "" : undefined}
            className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
          >
            <div className="flex min-w-0 flex-1 gap-3">
              {step.done ? (
                <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-state-success" />
              ) : (
                <Circle aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0">
                <p className={cn("font-medium", step.done && "text-muted-foreground")}>
                  {step.title}
                  <span className="sr-only">
                    {" "}
                    ({step.done ? t("gettingStarted.stepDone") : t("gettingStarted.stepToDo")})
                  </span>
                </p>
                {step.description && !step.done ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">{step.description}</p>
                ) : null}
              </div>
            </div>
            {step.done ? (
              <span aria-hidden className="text-xs text-muted-foreground sm:shrink-0">
                {t("gettingStarted.stepDone")}
              </span>
            ) : (
              <StepAction action={step.action} />
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

// 44px tall at every width (`touch`): a step's action is the one thing on the
// row to press, on a phone as much as with a mouse.
const STEP_ACTION_CLASS = "self-start sm:shrink-0 sm:self-auto";

function StepAction({ action }: { action: GettingStartedAction }) {
  if ("onClick" in action) {
    return (
      <Button
        type="button"
        variant="outline"
        size="touch"
        className={STEP_ACTION_CLASS}
        onClick={action.onClick}
      >
        {action.label}
      </Button>
    );
  }
  return (
    <Link
      {...action.link}
      className={cn(buttonVariants({ variant: "outline", size: "touch" }), STEP_ACTION_CLASS)}
    >
      {action.label}
    </Link>
  );
}
