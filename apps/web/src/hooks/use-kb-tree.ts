import { keepPreviousData, skipToken, useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";

import { useKbAccessLoss } from "@/hooks/use-kb-editor";
import { useKbHeadSha } from "@/hooks/use-kb-head-sha";
import { VIEWER_SCOPED_CACHE, viewerScopedKey } from "@/lib/viewer-scoped-key";
import { orpc } from "@/utils/orpc";

/** Tree pages: 2000 paths each, at most this many pages (a 40k-document KB). */
const TREE_PAGE = 2000;
const TREE_MAX_PAGES = 20;

/**
 * Every document path of the KB's main head, for the file tree and quick
 * open: paths only (no bodies), read page by page until done. The read is
 * pinned to the head the KB layout knows, so a save, create, move or delete
 * (each moves the head) reads the new tree, and all pages are one snapshot.
 * A KB the viewer can't read, or an empty one (no head), reads nothing.
 */
export function useKbTree(kbId: string, canRead: boolean, viewerId: string | null) {
  const head = useKbHeadSha(kbId);
  const options = orpc.documents.tree.infiniteOptions({
    input:
      canRead && head
        ? (cursor: string | null) => ({
            kbId,
            rev: head,
            limit: TREE_PAGE,
            ...(cursor ? { cursor } : {}),
          })
        : skipToken,
    initialPageParam: null as string | null,
    getNextPageParam: (last, pages) =>
      pages.length >= TREE_MAX_PAGES ? null : (last?.nextCursor ?? null),
    retry: false,
    // A new head keeps the current tree on screen until its tree arrives.
    placeholderData: keepPreviousData,
  });
  // The viewer's own answer (the app's cache outlives a sign-out): another
  // account gets another key and reads its own tree; unused, it is dropped.
  const query = useInfiniteQuery({
    ...options,
    ...VIEWER_SCOPED_CACHE,
    queryKey: viewerScopedKey(options.queryKey, viewerId),
  });
  const { hasNextPage, isFetchingNextPage, fetchNextPage, isError } = query;
  // The tree needs every page; keep reading while there is a next one.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
  useKbAccessLoss(kbId, [query.error]);
  const paths = useMemo(
    () => query.data?.pages.flatMap((page) => page?.paths ?? []) ?? [],
    [query.data],
  );
  return {
    paths,
    commitSha: query.data?.pages[0]?.commitSha ?? null,
    // An empty KB has no head and so no tree to wait for.
    isPending: canRead && head !== null && query.isPending,
    isError: query.isError,
    /** More pages exist than the tree reads: it shows the first part only. */
    truncated: !hasNextPage && Boolean(query.data?.pages.at(-1)?.nextCursor),
    loadingMore: hasNextPage || isFetchingNextPage,
    refetch: () => void query.refetch(),
    /** A later page failed: the tree so far stays; this reads the rest again. */
    retryMore: () => void fetchNextPage(),
  };
}
