import { useLayoutEffect, useSyncExternalStore } from "react";
import { authClient } from "@/lib/auth-client";
import {
  type AuthSessionState,
  getAuthSessionState,
  rememberConfirmedAnonymous,
} from "@/lib/auth-session-state";

import {
  announceDocumentIdentity,
  confirmDocumentIdentityFresh,
  identityVerificationGeneration,
  isDocumentIdentityUnverified,
  observeDocumentIdentity,
  replaceDocument,
  subscribeIdentityVerification,
} from "@/lib/document-identity";
import { connectSessionRetry, observeSessionRetry } from "@/lib/session-retry";
import { useSessionUnconfirmed } from "@/lib/session-unconfirmed";

import { useNetworkStatus } from "./use-network-status";

export { readSessionIdentityGeneration } from "@/lib/auth-client";

/** Read the same live atom as the adapter, including after an owner unmounts. */
export function getAuthActorKey(): string | null {
  const userId = authClient.$store.atoms.session?.get().data?.user.id;
  return userId ? `user:${userId}` : null;
}

/**
 * Whether Better Auth's session atom has settled anonymous in this document.
 * Module-level because the atom is: every caller reads the same session, so a
 * component that mounts during a refetch (a navigation from /login to /signup
 * while the tab regains focus) must not see a first load either. Only browser
 * snapshots write it; the server's are always the unresolved initial state.
 */
let confirmedAnonymous = false;
// Availability only, never session data. Keep Retry visible during its request
// instead of alternating the account control with a first-load skeleton.
let unavailableError: unknown | null = null;

// The adapter supplies one stable refetch action to every consumer. A retry
// also settles the neutral identity mask when a previous peer probe failed.
type Refetch = ReturnType<typeof authClient.useSession>["refetch"];
const refetches = new WeakMap<Refetch, Refetch>();
function verifiedRefetch(raw: Refetch): Refetch {
  let wrapped = refetches.get(raw);
  if (!wrapped) {
    wrapped = async (...args) => {
      const since = identityVerificationGeneration();
      const result = await raw(...args);
      const checked = readSessionIdentity();
      if (since === identityVerificationGeneration() && checked !== undefined) {
        if (observeDocumentIdentity(checked)) replaceDocument();
        else {
          confirmDocumentIdentityFresh(since);
          announceDocumentIdentity(checked);
        }
      }
      return result;
    };
    refetches.set(raw, wrapped);
  }
  return wrapped;
}

/**
 * The sole application adapter for Better Auth's reactive session atom.
 * `unmasked` is for the identity watcher only: it must see the raw session
 * even while the chrome is held neutral (`SessionUnconfirmed`, an unverified
 * identity), to notice the answer that settles it.
 */
export function useAuthSession({
  unmasked = false,
}: {
  unmasked?: boolean;
} = {}): AuthSessionState {
  const session = authClient.useSession();
  const isOnline = useNetworkStatus();
  if (typeof window !== "undefined") {
    if (session.error) unavailableError = session.error;
    else if (!session.isPending && !session.isRefetching) unavailableError = null;
  }
  const error =
    session.error ?? (session.isPending || session.isRefetching ? unavailableError : null);
  const refetch = verifiedRefetch(session.refetch);
  useLayoutEffect(() => connectSessionRetry(refetch), [refetch]);
  useLayoutEffect(() => {
    observeSessionRetry(session.error, session.isPending || session.isRefetching);
  }, [session.error, session.isPending, session.isRefetching]);
  // Under `SessionUnconfirmed` (the app shell's pending state), or while
  // another tab's identity change is unchecked here: nobody yet.
  const unconfirmed = useSessionUnconfirmed();
  const unverified = useSyncExternalStore(
    subscribeIdentityVerification,
    isDocumentIdentityUnverified,
    () => false,
  );
  if (!unmasked && (unconfirmed || unverified)) {
    return getAuthSessionState<NonNullable<typeof session.data>>({
      data: null,
      isPending: unconfirmed || error == null,
      isRefetching: session.isRefetching,
      error: unconfirmed ? null : error,
      isOnline,
      refetch,
      confirmedAnonymous: false,
    });
  }

  const result = getAuthSessionState({
    data: session.data,
    isPending: session.isPending,
    isRefetching: session.isRefetching,
    error,
    isOnline,
    refetch,
    confirmedAnonymous,
  });
  // A fact about the shared atom, not about this render: idempotent, and the
  // same for every caller that reads this snapshot.
  if (typeof window !== "undefined") {
    confirmedAnonymous = rememberConfirmedAnonymous(confirmedAnonymous, result.state);
  }
  return result;
}

/**
 * The atom's confirmed identity right now, outside React (the watcher reads it
 * after its own refetch settles): the user id, `null` when confirmed signed
 * out, `undefined` while unknown (pending, or a failed check).
 */
export function readSessionIdentity(): string | null | undefined {
  const snapshot = authClient.$store.atoms.session?.get();
  if (!snapshot || snapshot.isPending || snapshot.isRefetching) return undefined;
  if (snapshot.error) {
    // A 401 confirms the session is gone; any other failure confirms
    // nothing, even with the previous answer still retained in `data`.
    return (snapshot.error as { status?: unknown }).status === 401 ? null : undefined;
  }
  return snapshot.data ? snapshot.data.user.id : null;
}

/** A session fetch is in flight right now (another one superseded ours). */
export function isSessionFetchInFlight(): boolean {
  const snapshot = authClient.$store.atoms.session?.get();
  return snapshot ? snapshot.isPending || snapshot.isRefetching : false;
}

/** Forget the settled state, as a new document would. Tests only. */
export function resetAuthSessionMemoryForTests(): void {
  confirmedAnonymous = false;
  unavailableError = null;
}
