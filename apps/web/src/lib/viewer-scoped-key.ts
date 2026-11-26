import type { QueryKey } from "@tanstack/react-query";

/**
 * For answers that belong to the signed-in viewer under an oRPC key that does
 * not name the viewer (the same rule as kb-sharing's `use-viewer-scope`, which
 * this follows until both share one module): the app's query cache outlives a
 * sign-out, so these queries carry the viewer in their key and are dropped as
 * soon as nothing shows them.
 */
export const VIEWER_SCOPED_CACHE = { gcTime: 0 } as const;

/** `base` (an oRPC key) scoped to one viewer; `.key()` prefix invalidation still matches it. */
export function viewerScopedKey(base: QueryKey, viewerId: string | null): QueryKey {
  return [...base, { viewer: viewerId }];
}
