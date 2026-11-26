import { useQuery } from "@tanstack/react-query";

import { orpc } from "@/utils/orpc";

/**
 * The KB's main head as the KB layout last read it (`kbs.get`, which every
 * save and delete invalidates): reads keyed on it follow the KB's changes.
 * This observer never fetches on its own; the layout owns that read.
 */
export function useKbHeadSha(kbId: string): string | null {
  const { data } = useQuery({
    ...orpc.kbs.get.queryOptions({ input: { kbId } }),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    select: (result) => result?.kb.headSha ?? null,
  });
  return data ?? null;
}
