import { cn } from "@knowledge-base/ui/lib/utils";
import type { ReactNode } from "react";

import { WideContent } from "@/components/wide-content";

const WIDTH_CLASS = {
  narrow: "max-w-4xl",
  default: "max-w-5xl",
  wide: "max-w-7xl",
} as const;

type PageShellProps = {
  width?: keyof typeof WIDTH_CLASS;
  className?: string;
  children: ReactNode;
};

export function PageShell({ width = "default", className, children }: PageShellProps) {
  return (
    <div
      className={cn("container mx-auto space-y-6 px-4 py-6 md:py-8", WIDTH_CLASS[width], className)}
    >
      {children}
    </div>
  );
}

type PageHeaderProps = {
  title: string;
  description?: ReactNode;
  /** A line under the description: identifiers, status pills. */
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
};

/** Page title, muted description and the page's actions on the right (below on phones). */
export function PageHeader({ title, description, meta, actions, className }: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between",
        className,
      )}
    >
      <header className="min-w-0 space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight text-balance break-words">
          {title}
        </h1>
        {description ? (
          <p className="text-sm text-pretty text-muted-foreground">{description}</p>
        ) : null}
        {meta ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
            {meta}
          </div>
        ) : null}
      </header>
      {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export type SectionTab = {
  key: string;
  label: string;
  /** Renders the link (typed by the caller's route). */
  render: (className: string, activeClassName: string, children: ReactNode) => ReactNode;
};

// The router marks the active link `data-status="active"`; styling that state
// (not a second class list) keeps the active border from losing to the
// transparent one in the stylesheet order.
const TAB_CLASS =
  "-mb-px inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[status=active]:border-primary data-[status=active]:text-foreground";
const TAB_ACTIVE_CLASS = "font-semibold";

/** Tabs for a section's sub-pages; scrolls sideways inside WideContent on phones. */
export function SectionTabs({
  tabs,
  ariaLabel,
  className,
}: {
  tabs: readonly SectionTab[];
  ariaLabel: string;
  className?: string;
}) {
  return (
    <WideContent className={cn("border-b", className)}>
      <nav aria-label={ariaLabel} className="flex w-max gap-1">
        {tabs.map((tab) => (
          <span key={tab.key}>{tab.render(TAB_CLASS, TAB_ACTIVE_CLASS, tab.label)}</span>
        ))}
      </nav>
    </WideContent>
  );
}
