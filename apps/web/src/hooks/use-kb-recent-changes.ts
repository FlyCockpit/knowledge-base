import { skipToken, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";

import { useKbAccessLoss } from "@/hooks/use-kb-editor";
import { useKbHeadSha } from "@/hooks/use-kb-head-sha";
import type { RecentChange } from "@/lib/kb-workspace/agent-activity";
import { VIEWER_SCOPED_CACHE, viewerScopedKey } from "@/lib/viewer-scoped-key";
import { orpc } from "@/utils/orpc";

/** The KB's recent document changes on main, newest first, 20 commits a page. */
export function useKbRecentChanges(kbId: string, canRead: boolean, viewerId: string | null) {
  const queryClient = useQueryClient();
  const options = orpc.documents.recentChanges.infiniteOptions({
    input: canRead
      ? (cursor: string | null) => ({ kbId, limit: 20, ...(cursor ? { cursor } : {}) })
      : skipToken,
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last?.nextCursor ?? null,
    retry: false,
  });
  // The viewer's own answer: another account never sees this one's cached feed.
  const query = useInfiniteQuery({
    ...options,
    ...VIEWER_SCOPED_CACHE,
    queryKey: viewerScopedKey(options.queryKey, viewerId),
  });
  // Every change of the KB moves its head: read the list anew then.
  const head = useKbHeadSha(kbId);
  const seenHead = useRef(head);
  useEffect(() => {
    if (seenHead.current === head) return;
    seenHead.current = head;
    void queryClient.invalidateQueries({
      queryKey: orpc.documents.recentChanges.key({ input: { kbId } }),
    });
  }, [queryClient, kbId, head]);
  const lost = useKbAccessLoss(kbId, [query.error]);
  const items: RecentChange[] = useMemo(
    () => query.data?.pages.flatMap((page) => page?.items ?? []) ?? [],
    [query.data],
  );
  return {
    items: lost ? [] : items,
    lost,
    isPending: query.isPending,
    isError: query.isError,
    hasNextPage: query.hasNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: () => void query.fetchNextPage(),
    refetch: () => void query.refetch(),
  };
}
