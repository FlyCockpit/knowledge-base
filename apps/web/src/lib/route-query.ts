import { isCancelledError, type QueryClient, type QueryKey } from "@tanstack/react-query";

/** Attempts before a cancellation is treated as a real failure. */
const MAX_ATTEMPTS = 3;

/**
 * `ensureQueryData` for a route's `beforeLoad`/`loader`, safe against
 * component unmounts.
 *
 * A route that awaits a query which components also observe (`appConfig` is
 * read by the header's UserMenu and by the page) can lose its fetch: when the
 * last observer unmounts while a fetch whose `queryFn` read the abort signal
 * is in flight (a pending shell swapping for the real one does this), TanStack
 * Query cancels it with `revert: true`, and every awaiter rejects with a
 * `CancelledError`. A route then fails into its error boundary ("This page
 * didn't load") on a plain visit.
 *
 * So the route's own fetch uses `fetcher`, which must not take the abort
 * signal (pass the procedure's `.call()`, not its `queryOptions().queryFn`).
 * TanStack only cancels a fetch whose signal was read, so an unmount can't
 * cancel this one. If the route joined a component's in-flight fetch that does
 * get cancelled, it fetches again, a bounded number of times.
 */
export async function ensureRouteQuery<TData>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  fetcher: () => Promise<TData>,
): Promise<TData> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await queryClient.ensureQueryData<TData>({ queryKey, queryFn: () => fetcher() });
    } catch (error) {
      if (!isCancelledError(error) || attempt >= MAX_ATTEMPTS) throw error;
    }
  }
}
