import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Button } from "@knowledge-base/ui/components/button";

import { useUiLabels } from "@knowledge-base/ui/components/ui-labels";
import { cn } from "@knowledge-base/ui/lib/utils";
import { XIcon } from "lucide-react";
import * as React from "react";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  bodyClassName,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean;
  /** Classes for the inner scroll box that holds the children (padding, gap). */
  bodyClassName?: string;
}) {
  const labels = useUiLabels();
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        // The popup is capped at the visible viewport and does not scroll; its
        // body does. So a dialog taller than the screen never pushes its title,
        // close button or action bar off screen: the close button is pinned to
        // the popup, DialogHeader sticks to the top of the body and
        // DialogFooter to its bottom. A dialog should still fit without
        // scrolling at all (`pnpm check:dialogs` measures it); this is the
        // safety net. Rule: docs/ui.md § Form surfaces
        className={cn(
          "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100svh_-_var(--safe-area-top,0px)_-_var(--safe-area-bottom,0px)_-_2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-none bg-background text-xs/relaxed ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className,
        )}
        {...props}
      >
        <div
          data-slot="dialog-body"
          // The edge padding moves onto a sticky header or footer when there is
          // one (a sticky box cannot reach into its container's padding, so it
          // must own that space), and the body keeps it otherwise.
          className={cn(
            "grid min-h-0 grid-cols-[minmax(0,1fr)] gap-4 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pt-4 pb-4 has-[[data-slot=dialog-footer]]:pb-0 has-[[data-slot=dialog-header]]:pt-0",
            bodyClassName,
          )}
        >
          {children}
        </div>
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              // The hit area is a 44px square centred on the 28px button
              // (`icon-sm` is 28px at every width here). An inset expansion
              // would be measured from the padding box, inside the 1px border
              // (`-inset-2` gave 26 + 16 = 42px). At `right-2` the square ends
              // on the popup's edge. The focus ring is drawn inside the box, so
              // a clipping edge (`overflow-x-hidden`) cannot cut it off.
              <Button
                variant="ghost"
                className="absolute top-3 right-2 z-20 after:absolute after:top-1/2 after:left-1/2 after:size-11 after:-translate-x-1/2 after:-translate-y-1/2 after:content-[''] focus-visible:ring-inset focus-visible:ring-offset-0"
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="sr-only">{labels.close}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

/**
 * Title + description. Sticky at the top of the dialog body, so the title
 * stays visible if the body ever scrolls; it carries the body's top padding
 * (`pt-4`) itself, and `pr-12` keeps a long title clear of the close button.
 * In a dialog that fits (the rule) it renders exactly where a plain header
 * would.
 */
function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        "sticky top-0 z-10 flex flex-col gap-1 bg-background pt-4 pr-12 text-left md:pr-10",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The action bar. Sticky at the bottom of the dialog body, so the primary
 * action stays on screen however tall the content gets (from inside a
 * `<form>` too: the form's box ends where the footer does). It carries the
 * body's bottom padding (`pb-4`); `-mt-2 pt-2` gives the buttons a little air
 * when content scrolls under them without moving them. Primary action last in
 * source order: on phones the column is reversed, so it sits on top, nearest
 * the thumb.
 */
function DialogFooter({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "sticky bottom-0 z-10 -mt-2 flex flex-col-reverse gap-2 bg-background pt-2 pb-4 sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-sm font-medium", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-xs/relaxed text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
