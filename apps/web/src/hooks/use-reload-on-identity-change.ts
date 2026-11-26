import { useLayoutEffect } from "react";

import { useAuthSession } from "@/hooks/use-auth-session";
import type { AuthSessionState } from "@/lib/auth-session-state";
import {
  announceDocumentIdentity,
  connectIdentityPeers,
  observeDocumentIdentity,
  replaceDocument,
  type SessionIdentity,
} from "@/lib/document-identity";

/**
 * `undefined` (session pending or errored) is never acted on: a flaky session
 * check must not reload a signed-in user's page.
 */
export function sessionIdentity(
  state: AuthSessionState<{ user: { id: string } }>["state"],
): SessionIdentity {
  if (state.status === "authenticated") return state.session.user.id;
  if (state.status === "anonymous") return null;
  return undefined;
}

/**
 * Replaces the document when the signed-in user goes away while a page is
 * open (sign-out in another tab, session expiry or revocation, another account
 * signing in). The identity the document belongs to lives in
 * `lib/document-identity.ts`, not here, so it survives this shell unmounting;
 * the route guards check the same baseline before anything renders, which
 * covers a change made while no watching page was open. Mounted by the `_app`
 * shell and by each standalone page that shows private data outside it (device
 * approval, MCP consent); one of them at a time.
 *
 * It also connects the other open tabs: an identity this tab confirms (a
 * sign-in included, which Better Auth does not broadcast) makes them check
 * their session, and a request rejected for having no session
 * (`reportSessionRejected`) checks it here.
 */
export function useReloadOnIdentityChange(): void {
  const authSession = useAuthSession();
  const identity = sessionIdentity(authSession.state);
  const { refetch } = authSession.actions;

  // Connected first (effects run in order), so the first identity below is
  // already announced to the other tabs.
  useLayoutEffect(() => connectIdentityPeers(() => refetch()), [refetch]);

  // Layout effect: replace the document before the browser paints a frame
  // that pairs the new identity's chrome with the old identity's cached data.
  useLayoutEffect(() => {
    if (identity === undefined) return;
    if (observeDocumentIdentity(identity)) {
      replaceDocument();
      return;
    }
    announceDocumentIdentity(identity);
  }, [identity]);
}
