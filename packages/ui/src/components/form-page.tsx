import { cn } from "@knowledge-base/ui/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import type * as React from "react";

/**
 * Long-form layouts. Rule: patterns/design-system.md § Form surfaces
 *
 * A form with more than about six controls is not a dialog: it is a page of its own
 * (`FormPage`, its own route, deep-linkable, back button works) or a wide side
 * sheet (`<SheetContent size="wide">` + `SheetBody` + `SheetFooter`), and both
 * are built from the same parts:
 *
 * - `FormSection`: a titled group whose fields take two columns from `lg:`
 *   (1024px) and one on phones; a field that needs the full row passes
 *   `className="lg:col-span-2"`.
 * - `AdvancedSection`: a collapsed section for expert fields with safe
 *   defaults, showing a one-line summary of the current values while closed,
 *   so nothing is hidden without a trace.
 * - `FormActionBar`: the sticky action bar, one right-aligned row at every
 *   width (a phone keeps the fields in view), primary action last, so it is
 *   rightmost, under the thumb.
 */

const WIDTH_CLASS = {
  default: "max-w-5xl",
  wide: "max-w-7xl",
} as const;

type FormPageProps = {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** A back link (a router `<Link>`), shown before the title in the pinned title row. */
  back?: React.ReactNode;
  /** The action bar's buttons, primary last. */
  actions: React.ReactNode;
  width?: keyof typeof WIDTH_CLASS;
  /** Classes for the `<form>`'s content column (between header and action bar). */
  bodyClassName?: string;
} & Omit<React.ComponentProps<"form">, "title">;

/**
 * A full-page form: a pinned title row, the sections, a sticky action bar.
 * It fills the remaining height (`min-h-full`, or `flex-1` inside a layout
 * that is a flex column), so a short form's action bar sits at the bottom
 * of the screen, not right under the last field.
 * Render it as the whole route component inside the app shell; `<main>` is
 * the scroller, so the title row sticks to the top and the action bar to the
 * bottom of the visible area while the fields scroll.
 * Wire it to TanStack Form through the ordinary form props (`onSubmit`, `ref`,
 * `noValidate`), and call `focusFirstInvalidField` from `onSubmitInvalid`.
 */
function FormPage({
  title,
  description,
  back,
  actions,
  width = "default",
  className,
  bodyClassName,
  children,
  ...formProps
}: FormPageProps) {
  return (
    <form
      data-slot="form-page"
      className={cn(
        "container mx-auto flex min-h-full flex-1 flex-col px-4 pt-4",
        WIDTH_CLASS[width],
        className,
      )}
      {...formProps}
    >
      {/* The title row stays pinned while the fields scroll, below any sticky
          chrome of the layout around the page: a layout with a sticky sub-nav
          sets `--page-sticky-top` to that nav's height. */}
      <header
        data-slot="form-page-header"
        className="sticky top-[var(--page-sticky-top,0px)] z-30 -mx-4 flex min-h-14 items-center gap-2 bg-background/95 px-4 py-2 supports-backdrop-filter:bg-background/80 supports-backdrop-filter:backdrop-blur-lg"
      >
        {back ? <div className="-ml-2 shrink-0">{back}</div> : null}
        <h1 className="min-w-0 truncate text-2xl font-semibold tracking-tight">{title}</h1>
      </header>
      {description ? (
        <p className="max-w-prose pb-6 text-sm text-muted-foreground">{description}</p>
      ) : (
        <div className="pb-4" />
      )}
      <div data-slot="form-page-body" className={cn("flex-1 space-y-8 pb-8", bodyClassName)}>
        {children}
      </div>
      <FormActionBar>{actions}</FormActionBar>
    </form>
  );
}

/**
 * The sticky action bar of a `FormPage` (or any long form inside `<main>`):
 * pinned to the bottom of the scroller at the sticky-chrome layer (`z-30`),
 * full-bleed inside its container's padding.
 * See patterns/design-system.md § Layer scale
 */
function FormActionBar({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="form-action-bar"
      className={cn(
        "sticky bottom-0 z-30 -mx-4 flex flex-wrap items-center justify-end gap-2 border-t bg-background/95 px-4 py-3 supports-backdrop-filter:bg-background/80 supports-backdrop-filter:backdrop-blur-lg",
        className,
      )}
      {...props}
    />
  );
}

type FormSectionProps = {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Classes for the fields grid. */
  gridClassName?: string;
} & Omit<React.ComponentProps<"section">, "title">;

/** A titled group of fields: one column on phones, two from `lg:` (1024px). */
function FormSection({
  title,
  description,
  className,
  gridClassName,
  children,
  ...props
}: FormSectionProps) {
  return (
    <section data-slot="form-section" className={cn("space-y-4", className)} {...props}>
      <div className="space-y-1">
        <h2 className="text-base font-medium">{title}</h2>
        {description ? (
          <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      <div className={cn("grid grid-cols-1 gap-4 lg:grid-cols-2", gridClassName)}>{children}</div>
    </section>
  );
}

type AdvancedSectionProps = {
  title: React.ReactNode;
  /**
   * One line naming the current values, shown while the section is closed
   * ("2 vCPU · 4 GiB · destroy after 5 min"), so a hidden default is never a
   * secret.
   */
  summary?: React.ReactNode;
  description?: React.ReactNode;
  defaultOpen?: boolean;
  gridClassName?: string;
} & Omit<React.ComponentProps<"details">, "title" | "open">;

/**
 * A collapsed section for fields with safe defaults most people never change.
 * A native `<details>`: the fields stay mounted while it is closed (their
 * values and validation are intact), the browser opens it for find-in-page,
 * and `focusFirstInvalidField` opens it before focusing an invalid field
 * inside. Name several by topic ("Size", "Environment", "Network") rather than
 * one catch-all "Advanced" when a form has more than a handful.
 */
function AdvancedSection({
  title,
  summary,
  description,
  defaultOpen,
  className,
  gridClassName,
  children,
  ...props
}: AdvancedSectionProps) {
  return (
    <details
      data-slot="advanced-section"
      className={cn(
        // Stacked sections join into one ruled list: inside a FormPage body
        // (space-y-8) a section right after another drops its gap and top rule.
        "group/advanced border-y [[data-slot=advanced-section]+&]:-mt-8 [[data-slot=advanced-section]+&]:border-t-0",
        className,
      )}
      open={defaultOpen || undefined}
      {...props}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-2 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-open/advanced:rotate-90 motion-reduce:transition-none"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
          <span className="text-base font-medium">{title}</span>
          {summary ? (
            <span
              data-slot="advanced-section-summary"
              className="min-w-0 truncate text-sm text-muted-foreground group-open/advanced:hidden"
            >
              {summary}
            </span>
          ) : null}
        </span>
      </summary>
      <div className="space-y-4 pt-2 pb-6">
        {description ? (
          <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
        ) : null}
        <div className={cn("grid grid-cols-1 gap-4 lg:grid-cols-2", gridClassName)}>{children}</div>
      </div>
    </details>
  );
}

export { AdvancedSection, FormActionBar, FormPage, FormSection };
