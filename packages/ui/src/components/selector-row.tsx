import { cn } from "@knowledge-base/ui/lib/utils";
import type * as React from "react";

type SelectorRowProps = React.ComponentProps<"div"> & {
  /** Extra classes for the inner flex track (e.g. `gap-1 px-4 py-2`). */
  innerClassName?: string;
};

/**
 * Layout primitive for horizontal selector rows (segmented controls, tab
 * bars, filter pills, settings sub-nav). Encapsulates the design-system
 * recipe: the outer region scrolls itself horizontally
 * (`overflow-x-auto overflow-y-hidden overscroll-x-contain no-scrollbar`
 * with a `min-w-0` contract) so a too-wide bar never scrolls the page, and
 * the inner `w-max` track keeps children on one line with `shrink-0`
 * enforced. It is not a tab system — compose it with `ToggleGroup`, pill
 * buttons, links, etc.
 */
function SelectorRow({ className, innerClassName, children, ...props }: SelectorRowProps) {
  return (
    <div
      data-slot="selector-row"
      className={cn(
        "min-w-0 max-w-full overflow-x-auto overflow-y-hidden overscroll-x-contain no-scrollbar",
        className,
      )}
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

export { SelectorRow };
