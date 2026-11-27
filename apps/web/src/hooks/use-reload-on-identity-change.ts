import { useLayoutEffect } from "react";

import {
  isSessionFetchInFlight,
  readSessionIdentity,
  readSessionIdentityGeneration,
  useAuthSession,
} from "@/hooks/use-auth-session";
import type { AuthSessionState } from "@/lib/auth-session-state";
import {
  announceDocumentIdentity,
  confirmDocumentIdentityFresh,
  connectIdentityPeers,
  identityVerificationGeneration,
  isDocumentIdentityUnverified,
  isDocumentReplaced,
  observeDocumentIdentity,
  replaceDocument,
  type SessionIdentity,
} from "@/lib/document-identity";

import { runSessionCheck } from "@/lib/session-retry";

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
 * check settles it). Checks share the document's retry coordinator and must
 * start after the invalidation they verify (`since`). The adapter's stable
 * refetch wrapper also verifies retries started by the header or scheduler.
 * A failed check is retried with backoff and when the tab regains focus,
 * visibility or the network; one superseded by another fetch still running is
 * followed up (at most 3 times, 250 ms apart). `stop()` drops every pending
 * completion, timer and listener.
 */
function startIdentityChecks(refetch: () => unknown): { stop: () => void } {
  let connected = true;
  let followUp: ReturnType<typeof setTimeout> | undefined;
  const check = (superseded = 0): Promise<void> => {
    if (!connected || isDocumentReplaced()) return Promise.resolve();
    let since = identityVerificationGeneration();
    return runSessionCheck(
      () => {
        // The coordinator may wait for an older native refresh before starting
        // this fresh probe. Verify the generation it actually starts in.
        if (!connected) return;
        // This probe now owns verification. A previously scheduled provenance
        // retry must not outlive it; rejected automatic checks never get here.
        clearTimeout(followUp);
        since = identityVerificationGeneration();
        return refetch();
      },
      { automatic: true },
    ).then((ran) => {
      if (!ran || !connected || isDocumentReplaced()) return;
      // A joined completion can belong to a disconnected producer that
      // skipped its probe. Its retained atom answer still needs provenance.
      if (since !== identityVerificationGeneration() || readSessionIdentityGeneration() !== since) {
        if (superseded < 3) {
          clearTimeout(followUp);
          followUp = setTimeout(() => void check(superseded + 1).catch(() => {}), 250);
        }
        return;
      }
      const checked = readSessionIdentity();
      if (checked === undefined) {
        if (isSessionFetchInFlight() && superseded < 3) {
          clearTimeout(followUp);
          followUp = setTimeout(() => void check(superseded + 1).catch(() => {}), 250);
        }
        return;
      }
      // A joined older completion may have queued a retry after this probe
      // started. Its fresh, settled answer makes that retry unnecessary too.
      clearTimeout(followUp);
      if (observeDocumentIdentity(checked)) replaceDocument();
      else {
        confirmDocumentIdentityFresh(since);
        announceDocumentIdentity(checked);
      }
    });
  };
  const retry = () => {
    if (readSessionIdentity() === null && !isDocumentIdentityUnverified()) return;
    if (document.visibilityState !== "hidden" && navigator.onLine !== false)
      void check().catch(() => {});
  };
  const disconnectPeers = connectIdentityPeers(() => check());
  if (
    isDocumentIdentityUnverified() ||
    readSessionIdentityGeneration() !== identityVerificationGeneration()
  )
    void check().catch(() => {});
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
 * covers a change made while no watching page was open. Mounted by the
 * `_app` shell and standalone device/consent pages (one watcher at a time).
 *
 * It also connects the other open tabs: an identity this tab confirms (a
 * sign-in included, which Better Auth does not broadcast) asks conflicting
 * peers to verify their session here, alongside change hints and requests
 * rejected for having no session (`reportSessionRejected`).
 */
export function useReloadOnIdentityChange(): void {
  // Raw, never masked: the identity effect below must see the session even
  // while the chrome is held neutral.
  const authSession = useAuthSession({ unmasked: true });
  const identity = sessionIdentity(authSession.state);
  const since = identityVerificationGeneration();
  const answerGeneration = readSessionIdentityGeneration();
  const { isDegraded, isRefetching } = authSession.meta;
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
    // Retained presentation data is not a new confirmation. In particular a
    // remount after a peer invalidation must wait for its own current probe.
    if (
      identity === undefined ||
      isDegraded ||
      isRefetching ||
      isDocumentIdentityUnverified() ||
      answerGeneration !== since ||
      since !== identityVerificationGeneration()
    )
      return;
    if (observeDocumentIdentity(identity)) {
      replaceDocument();
      return;
    }
    // Only the settled, successful atom answer can be broadcast. The
    // presentation adapter may retain an identity through a failed check.
    if (readSessionIdentity() === identity) announceDocumentIdentity(identity);
  }, [identity, isDegraded, isRefetching, since, answerGeneration]);
}
