import { cn } from "@knowledge-base/ui/lib/utils";
import type { ComponentProps } from "react";

/** Isolated horizontal scroller for tables and other intentionally wide content. */
const WIDE_CONTENT_CLASS_NAME =
  "min-w-0 max-w-full overflow-x-auto overflow-y-hidden overscroll-x-contain";

export function WideContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn(WIDE_CONTENT_CLASS_NAME, className)} {...props} />;
}
