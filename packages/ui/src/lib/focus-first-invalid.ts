/**
 * Moves focus to the first invalid control inside `root`, in DOM order, and
 * scrolls it into view. Call it from TanStack Form's `onSubmitInvalid`, so a
 * failed submit lands the user on the field that needs fixing instead of
 * leaving them to hunt for an error below the fold.
 * See patterns/forms.md § Errors next to the field
 *
 * "Invalid" is `aria-invalid="true"`, which `TextField`, `SelectField`,
 * `RangeField` and `KeyValueEditor` set from the field's errors. React commits
 * those attributes after the submit handler returns, so the lookup waits one
 * frame. A field inside a closed `AdvancedSection` (a `<details>`) gets its
 * section opened first: a closed section's content cannot take focus.
 * Returns the frame handle so a caller can cancel it.
 */
export function focusFirstInvalidField(
  root: Pick<ParentNode, "querySelector"> | null | undefined,
  schedule: (callback: () => void) => unknown = (callback) => requestAnimationFrame(callback),
): unknown {
  if (!root) return undefined;
  return schedule(() => {
    const target = root.querySelector<HTMLElement>(FIRST_INVALID_SELECTOR);
    if (!target) return;
    for (let details = target.closest?.("details"); details; ) {
      details.open = true;
      details = details.parentElement?.closest("details") ?? null;
    }
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "center", inline: "nearest" });
  });
}

/** Exported for tests and for callers that need the same notion of "invalid". */
// `:disabled` (not `[disabled]`): a control inside `<fieldset disabled>` is
// disabled without carrying the attribute itself, and cannot take focus.
export const FIRST_INVALID_SELECTOR = '[aria-invalid="true"]:not(:disabled)';
