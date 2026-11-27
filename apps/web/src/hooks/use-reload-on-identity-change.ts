import { useLayoutEffect } from "react";

import {
  isSessionFetchInFlight,
  readSessionIdentity,
  useAuthSession,
} from "@/hooks/use-auth-session";
import type { AuthSessionState } from "@/lib/auth-session-state";
import {
  announceDocumentIdentity,
  confirmDocumentIdentityFresh,
  connectIdentityPeers,
  identityVerificationGeneration,
  isDocumentIdentityUnverified,
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
 * The watcher's session checks while it is mounted: for a peer tab's
 * announcement, a 401, and an unverified identity (another tab announced a
 * change while no watcher was mounted: the chrome shows no account until a
 * check settles it). Only a check started here can settle that state:
 * Better Auth's refetch cancels any fetch already in flight, so the answer it
 * settles with was asked for after `since`, never inherited from before a
 * newer invalidation. A failed check is retried when the tab regains focus,
 * visibility or the network; one superseded by another fetch still running is
 * followed up (at most 3 times, 250 ms apart; one follow-up pending at a time,
 * the newest check's). `stop()` drops every pending completion, timer and
 * listener, and nothing refetches after it.
 */
function startIdentityChecks(refetch: () => unknown): { stop: () => void } {
  let connected = true;
  let followUp: ReturnType<typeof setTimeout> | undefined;
  const check = (superseded = 0): Promise<void> => {
    if (!connected) return Promise.resolve();
    const since = identityVerificationGeneration();
    return Promise.resolve(refetch()).then(
      () => {
        if (!connected || !isDocumentIdentityUnverified()) return;
        const checked = readSessionIdentity();
        if (checked === undefined) {
          if (isSessionFetchInFlight() && superseded < 3) {
            // Overlapping checks share the one slot, so `stop()` clears it.
            clearTimeout(followUp);
            followUp = setTimeout(() => void check(superseded + 1), 250);
          }
          return;
        }
        if (observeDocumentIdentity(checked)) replaceDocument();
        else confirmDocumentIdentityFresh(since);
      },
      () => {
        // A failed check decides nothing; focus, visibility or the network retries it.
      },
    );
  };
  const retry = () => {
    if (isDocumentIdentityUnverified() && document.visibilityState !== "hidden") void check();
  };
  const disconnectPeers = connectIdentityPeers(() => check());
  if (isDocumentIdentityUnverified()) void check();
  window.addEventListener("focus", retry);
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", retry);
  return {
    stop: () => {
      connected = false;
      clearTimeout(followUp);
      disconnectPeers();
      window.removeEventListener("focus", retry);
      window.removeEventListener("online", retry);
      document.removeEventListener("visibilitychange", retry);
    },
  };
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
  // Raw, never masked: the identity effect below must see the session even
  // while the chrome is held neutral.
  const authSession = useAuthSession({ unmasked: true });
  const identity = sessionIdentity(authSession.state);
  const { refetch } = authSession.actions;

  // Connected first (effects run in order), so the first identity below is
  // already announced to the other tabs.
  useLayoutEffect(() => {
    const watcher = startIdentityChecks(refetch);
    return () => watcher.stop();
  }, [refetch]);

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
