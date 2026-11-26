import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { Button } from "@knowledge-base/ui/components/button";

import { useUiLabels } from "@knowledge-base/ui/components/ui-labels";
import { cn } from "@knowledge-base/ui/lib/utils";
import { XIcon } from "lucide-react";
import * as React from "react";

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 text-xs/relaxed transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs",
        className,
      )}
      {...props}
    />
  );
}

/**
 * `size="wide"` is the long-form side sheet: full width on phones, then up to 48rem, then 64rem from `xl:`, so
 * a body of `FormSection`s gets its two columns at ≥1024px. Pair it with
 * `SheetBody` (the one scroller) between `SheetHeader` and `SheetFooter`, both
 * of which stay put.
 */
function SheetContent({
  className,
  children,
  side = "right",
  size = "default",
  showCloseButton = true,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: "top" | "right" | "bottom" | "left";
  size?: "default" | "wide";
  showCloseButton?: boolean;
}) {
  const labels = useUiLabels();
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        data-size={size}
        className={cn(
          "fixed z-50 flex flex-col overscroll-contain bg-background bg-clip-padding text-xs/relaxed shadow-lg transition duration-200 ease-in-out data-ending-style:opacity-0 data-starting-style:opacity-0 data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=bottom]:data-ending-style:translate-y-[2.5rem] data-[side=bottom]:data-starting-style:translate-y-[2.5rem] data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=left]:data-ending-style:translate-x-[-2.5rem] data-[side=left]:data-starting-style:translate-x-[-2.5rem] data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=right]:data-ending-style:translate-x-[2.5rem] data-[side=right]:data-starting-style:translate-x-[2.5rem] data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=top]:data-ending-style:translate-y-[-2.5rem] data-[side=top]:data-starting-style:translate-y-[-2.5rem] data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm data-[size=wide]:data-[side=left]:w-full data-[size=wide]:data-[side=right]:w-full data-[size=wide]:data-[side=left]:sm:max-w-3xl data-[size=wide]:data-[side=right]:sm:max-w-3xl data-[size=wide]:data-[side=left]:xl:max-w-5xl data-[size=wide]:data-[side=right]:xl:max-w-5xl",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            // 44px box flush with the edge: the focus ring is drawn inside it,
            // so the viewport cannot clip it.
            render={
              <Button
                variant="ghost"
                className="absolute top-1 right-0 focus-visible:ring-inset focus-visible:ring-offset-0"
                size="icon-touch"
              />
            }
          >
            <XIcon />
            <span className="sr-only">{labels.close}</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
}

/** Title + description; never scrolls away (`pr-12` clears the close button). */
function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex shrink-0 flex-col gap-0.5 p-4 pr-12", className)}
      {...props}
    />
  );
}

/**
 * The sheet's one scroller, between the header and the footer. Without it a
 * long form runs off the bottom of the fixed-height popup with no way to
 * reach the end.
 */
function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-body"
      className={cn(
        "min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-4 pb-4",
        className,
      )}
      {...props}
    />
  );
}

/**
 * The action bar, pinned to the bottom of the sheet: outside `SheetBody`, so
 * the primary action is always on screen. Primary action last in source
 * order; from `sm:` the actions sit in a row at the end.
 */
function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn(
        "mt-auto flex shrink-0 flex-col-reverse gap-2 border-t bg-background p-4 pb-[max(1rem,var(--safe-area-bottom,0px))] sm:flex-row sm:justify-end",
        className,
      )}
      {...props}
    />
  );
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-sm font-medium text-foreground", className)}
      {...props}
    />
  );
}

function SheetDescription({ className, ...props }: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-xs/relaxed text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetBody,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
};
