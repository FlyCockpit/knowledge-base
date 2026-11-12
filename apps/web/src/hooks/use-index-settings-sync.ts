import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { orpc } from "@/utils/orpc";

type IndexStatus = Awaited<ReturnType<AppRouterClient["kbIndex"]["profile"]>>["index"];

/** The parts of the index status whose change can alter settings (failure, chunk count). */
export function indexBuildSignature(index: IndexStatus | null): string | null {
  if (!index) return null;
  return [
    index.activeGenerationId,
    index.activeState,
    index.desiredGenerationId,
    index.desiredState,
    index.freshness,
    index.errorCode,
  ].join("|");
}

/**
 * Refreshes index settings: one KB's (e.g. after a denied owner-only edit, so
 * `canConfigureLimit` follows a lost ownership), or every KB's (after an admin
 * ceiling change, which moves `maxLimit`/`caps` without any build-state change).
 */
export function invalidateIndexSettings(queryClient: QueryClient, kbId?: string): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey:
      kbId === undefined
        ? orpc.kbIndex.settings.key()
        : orpc.kbIndex.settings.queryKey({ input: { kbId } }),
  });
}

/**
 * Invalidates the KB's index settings when a known build signature changes to another
 * known one (a build was queued, settled, failed or was superseded). Returns whether it did.
 */
export function syncIndexSettingsOnBuildChange(
  queryClient: QueryClient,
  kbId: string,
  previous: string | null,
  next: string | null,
): boolean {
  if (previous === null || next === null || previous === next) return false;
  void invalidateIndexSettings(queryClient, kbId);
  return true;
}

/**
 * Follows the (already polled) profile query's index status and refreshes the index
 * settings — `buildFailure`, `activeChunkCount` and hence the quantization refusals —
 * whenever a build changes state, whichever control started it.
 */
export function useIndexSettingsSync(kbId: string, index: IndexStatus | null): void {
  const queryClient = useQueryClient();
  const signature = indexBuildSignature(index);
  const previous = useRef(signature);
  useEffect(() => {
    if (signature === null) return;
    syncIndexSettingsOnBuildChange(queryClient, kbId, previous.current, signature);
    previous.current = signature;
  }, [queryClient, kbId, signature]);
}
