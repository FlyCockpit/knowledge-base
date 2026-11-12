import * as React from "react";

/**
 * Debounce a changing value. Used by the async search loop so we don't fire a
 * request on every keystroke.
 */
function useDebounce<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = React.useState(value);

  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

/**
 * Shared async-search loop for `AsyncCombobox` and `MultiAsyncCombobox`.
 *
 * Debounces the query, fires `fetchResults` with an `AbortSignal`, and cancels
 * the in-flight request whenever the query (or the fetcher) changes. This is
 * the "cancel the previous fetch on every keystroke" semantics that React Query
 * intentionally does not give us.
 *
 * `fetchResults` is a data fetcher, not an event-notification callback: it
 * pulls results *down* into this hook's own state (returned below), and never
 * pushes live state up to a parent.
 */
function useAsyncSearch<T>(
  fetchResults: (query: string, signal: AbortSignal) => Promise<T[]>,
  query: string,
) {
  const [results, setResults] = React.useState<T[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const debouncedQuery = useDebounce(query, 300);

  React.useEffect(() => {
    const abortController = new AbortController();

    async function search() {
      setIsLoading(true);
      try {
        const data = await fetchResults(debouncedQuery, abortController.signal);
        if (!abortController.signal.aborted) {
          setResults(data);
        }
      } catch {
        if (!abortController.signal.aborted) {
          setResults([]);
        }
      } finally {
        if (!abortController.signal.aborted) {
          setIsLoading(false);
        }
      }
    }

    search();
    return () => abortController.abort();
  }, [debouncedQuery, fetchResults]);

  return { results, isLoading };
}

export { useAsyncSearch, useDebounce };
