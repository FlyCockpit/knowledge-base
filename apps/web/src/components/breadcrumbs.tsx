import { cn } from "@knowledge-base/ui/lib/utils";
import { ChevronRight } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

export type Crumb = {
  key: string;
  label: string;
  /** Renders the link (typed by the caller's route). The last crumb is the page itself. */
  render?: (className: string, children: ReactNode) => ReactNode;
  /** Monospace label (a document path). */
  mono?: boolean;
};

const LINK_CLASS =
  "inline-flex min-h-11 min-w-0 items-center truncate rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** "Knowledge bases › Engineering › runbooks/x.md": every level but the page is a link. */
export function Breadcrumbs({ items, className }: { items: readonly Crumb[]; className?: string }) {
  const { t } = useTranslation("common");
  return (
    <nav aria-label={t("breadcrumbs.ariaLabel")} className={cn("min-w-0", className)}>
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          const label = (
            <span className={cn("truncate", item.mono && "font-mono")}>{item.label}</span>
          );
          return (
            <Fragment key={item.key}>
              {index > 0 && (
                <li aria-hidden="true" className="text-muted-foreground">
                  <ChevronRight className="size-3.5" />
                </li>
              )}
              <li className="flex min-w-0 max-w-full items-center">
                {last || !item.render ? (
                  <span
                    aria-current={last ? "page" : undefined}
                    className="inline-flex min-h-11 min-w-0 items-center font-medium"
                  >
                    {label}
                  </span>
                ) : (
                  item.render(LINK_CLASS, label)
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
