import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { cn } from "@knowledge-base/ui/lib/utils";
import type { ReactNode } from "react";

type SkeletonListProps = {
  count?: number;
  className?: string;
  children?: ReactNode;
};

/** Layout-matching skeleton rows for admin-style lists. */
export function SkeletonList({ count = 5, className, children }: SkeletonListProps) {
  return (
    <ul className={cn("divide-y", className)}>
      {Array.from({ length: count }, (_, index) => (
        <li key={`skel-${index}`} className="flex items-center justify-between gap-3 px-4 py-3">
          {children ?? (
            <>
              <div className="min-w-0 flex-1 space-y-2">
                <Skeleton className="h-5 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              <Skeleton className="h-8 w-16" />
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
