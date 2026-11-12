import { cn } from "@knowledge-base/ui/lib/utils";
import type { ReactNode } from "react";
import { InlineRetry } from "@/components/inline-retry";
import { isQueryAccessError } from "@/lib/query-access-error";

type QueryLike<T> = {
  data: T | undefined;
  error?: unknown;
  isPending: boolean;
  isError: boolean;
  refetch: () => unknown;
};

type QueryBoundaryProps<T> = {
  query: QueryLike<T>;
  skeleton: ReactNode;
  errorMessage?: string;
  errorClassName?: string;
  empty?: ReactNode;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => ReactNode;
};

/**
 * Pending → skeleton, error → InlineRetry, optional empty, else children.
 * Pending is checked first so `isPending && isError` cannot render both.
 *
 * **A failed refetch never wipes data that already loaded.** TanStack Query
 * sets `status: "error"` when a background refetch or a `fetchNextPage` fails,
 * while keeping the last successful `data`. Replacing a rendered list with an
 * error card in that case loses the user's scroll position and everything they
 * were reading, over a failure that may already have healed. So the error card
 * owns the whole slot only while `data === undefined` (nothing has ever
 * loaded); once there is data, the content stays on screen and the failure is
 * surfaced as a retry banner above it. Access denials are the exception: cached
 * private content is hidden immediately, while callers retain their authority rechecks.
 *
 * For always-enabled queries only. A disabled query (`skipToken` /
 * `enabled: false`) settles as `data === undefined` with neither `isPending`
 * nor `isError`, which is indistinguishable here from a query that resolved to
 * nothing — so it renders `empty` (or InlineRetry) rather than nothing. Render
 * disabled queries yourself instead of wrapping them.
 */
export function QueryBoundary<T>({
  query,
  skeleton,
  errorMessage,
  errorClassName,
  empty,
  isEmpty,
  children,
}: QueryBoundaryProps<T>) {
  const { isPending, isError, refetch } = query;
  const data = isQueryAccessError(query.error) ? undefined : query.data;

  if (isPending) return skeleton;

  if (data === undefined) {
    // Nothing to keep on screen: the error card takes the content's slot.
    if (isError || empty === undefined) {
      return (
        <InlineRetry
          className={errorClassName}
          message={errorMessage}
          onRetry={() => void refetch()}
        />
      );
    }
    return empty;
  }

  const content = isEmpty?.(data) ? (empty ?? null) : children(data);
  if (!isError) return content;

  // Stale-but-rendered: keep the content and put the retry above it.
  return (
    <>
      <InlineRetry
        variant="destructive"
        className={cn("mb-3", errorClassName)}
        message={errorMessage}
        onRetry={() => void refetch()}
      />
      {content}
    </>
  );
}
