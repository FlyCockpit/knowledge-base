import { cn } from "@knowledge-base/ui/lib/utils";
import type { ReactNode } from "react";

export type PillTone = "good" | "busy" | "bad" | "muted" | "info";

/** Tint + text pairs at AA in both themes (apps/web/src/lib/theme-contrast.test.ts). */
const PILL_TONE: Record<PillTone, string> = {
  good: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  busy: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  bad: "bg-destructive/15 text-destructive",
  muted: "bg-muted text-muted-foreground",
  info: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
};

/** A small status label. Never the only signal: the text says the state. */
export function StatusPill({
  tone,
  children,
  className,
  ...props
}: {
  tone: PillTone;
  children: ReactNode;
  className?: string;
} & Omit<React.ComponentProps<"span">, "children" | "className">) {
  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium",
        PILL_TONE[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
