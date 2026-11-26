import type { QueryKey } from "@tanstack/react-query";

import { useAuthSession } from "@/hooks/use-auth-session";

/**
 * For answers that belong to the signed-in viewer (who invited whom, at which
 * address, with which link) under an oRPC key that does not name the viewer.
 * The app's query cache outlives sign-out (see the kb-sharing follow-up), so
 * these queries carry the viewer in their key and are dropped as soon as
 * nothing shows them: another account, in this tab or after a switch in
 * another one, gets a different key and fetches its own answer, never the
 * previous account's.
 */
export const VIEWER_SCOPED_CACHE = { gcTime: 0 } as const;

/** The signed-in viewer's id, or null while nobody is (or it is not known yet). */
export function useViewerId(): string | null {
  const auth = useAuthSession();
  return auth.state.status === "authenticated" ? auth.state.session.user.id : null;
}

/** `base` (an oRPC key) scoped to one viewer; `.key()` prefix invalidation still matches it. */
export function viewerScopedKey(base: QueryKey, viewerId: string | null): QueryKey {
  return [...base, { viewer: viewerId }];
}
