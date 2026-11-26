import { edgeAttributes, useScrollEdges } from "@knowledge-base/ui/hooks/use-scroll-edges";
import { cn } from "@knowledge-base/ui/lib/utils";
import * as React from "react";

type SelectorRowProps = React.ComponentProps<"div"> & {
  /** Extra classes for the inner flex track (e.g. `gap-1 px-4 py-2`). */
  innerClassName?: string;
};

/**
 * Keep a keyboard-focused item fully in view, clear of the edge fade
 * (`scroll-padding-inline` on the row). Instant under reduced motion.
 */
function revealFocusedItem(event: React.FocusEvent<HTMLDivElement>) {
  const target = event.target;
  if (target === event.currentTarget || typeof target.scrollIntoView !== "function") return;
  const reduce =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  target.scrollIntoView({
    block: "nearest",
    inline: "nearest",
    behavior: reduce ? "auto" : "smooth",
  });
}

/**
 * Layout primitive for horizontal selector rows (segmented controls, tab
 * bars, filter pills, settings sub-nav). Encapsulates the design-system
 * recipe: the outer region scrolls itself horizontally
 * (`overflow-x-auto overflow-y-hidden overscroll-x-contain no-scrollbar`
 * with a `min-w-0` contract) so a too-wide bar never scrolls the page, and
 * the inner `w-max` track keeps children on one line with `shrink-0`
 * enforced. While the track overflows, the edge with more content past it
 * fades out (`scroll-fade-x`, re-measured on scroll and resize), and a
 * focused item is scrolled clear of the fade. It is not a tab system —
 * compose it with `ToggleGroup`, pill buttons, links, etc.
 */
function SelectorRow({ className, innerClassName, children, onFocus, ...props }: SelectorRowProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(ref);

  return (
    <div
      ref={ref}
      data-slot="selector-row"
      {...edgeAttributes(edges)}
      className={cn(
        "min-w-0 max-w-full overflow-x-auto overflow-y-hidden overscroll-x-contain no-scrollbar scroll-fade-x scroll-px-6",
        className,
      )}
      onFocus={(event) => {
        onFocus?.(event);
        revealFocusedItem(event);
      }}
      {...props}
    >
      <div
        data-slot="selector-row-track"
        className={cn("flex w-max min-w-full items-center gap-2 [&>*]:shrink-0", innerClassName)}
      >
        {children}
      </div>
    </div>
  );
}

export { revealFocusedItem, SelectorRow };
