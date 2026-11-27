import type { authClient } from "./auth-client";

type BetterAuthSessionSnapshot = ReturnType<typeof authClient.useSession>;

type AuthSession = NonNullable<BetterAuthSessionSnapshot["data"]>;
type AuthSessionRefetch = BetterAuthSessionSnapshot["refetch"];

type AuthSessionActions = {
  /** Revalidate the Better Auth session. The same stable action retries failures. */
  refetch: AuthSessionRefetch;
  retry: AuthSessionRefetch;
};

type AuthSessionMeta = {
  isRefetching: boolean;
  isOffline: boolean;
  /** A confirmed identity is being retained while verification is impaired. */
  isDegraded: boolean;
};

type AuthSessionStateValue<TSession> =
  | { status: "pending" }
  | { status: "authenticated"; session: TSession }
  | { status: "anonymous" }
  | { status: "error" };

export type AuthSessionState<TSession = AuthSession> = {
  state: AuthSessionStateValue<TSession>;
  actions: AuthSessionActions;
  meta: AuthSessionMeta;
};

export type AuthSessionStateInput<TSession> = {
  data: TSession | null;
  isPending: boolean;
  isRefetching: boolean;
  error: unknown | null;
  isOnline: boolean;
  refetch: AuthSessionRefetch;
  /**
   * An earlier snapshot in this document already settled anonymous (see
   * {@link rememberConfirmedAnonymous}). Better Auth marks every refetch of an
   * empty session `isPending` again (each request sets `isPending: data ===
   * null`), so a refocus looks exactly like the first load; only this memory
   * tells them apart.
   */
  confirmedAnonymous: boolean;
};

function isUnauthorizedError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 401;
}

/**
 * Convert Better Auth's session atom snapshot into the application contract.
 * Data wins over transient errors so confirmed identity remains available.
 */
export function getAuthSessionState<TSession>(
  input: AuthSessionStateInput<TSession>,
): AuthSessionState<TSession> {
  const hasConfirmedIdentity = input.data !== null;
  const isOffline = !input.isOnline;
  const actions = { refetch: input.refetch, retry: input.refetch };
  const meta = {
    isRefetching: input.isRefetching,
    isOffline,
    isDegraded: hasConfirmedIdentity && (input.error !== null || isOffline),
  };

  if (input.data !== null) {
    return {
      state: { status: "authenticated", session: input.data },
      actions,
      meta,
    };
  }

  // Better Auth clears confirmed data on a 401. Treat that explicit session
  // loss like a confirmed anonymous response, not an availability failure.
  if (isUnauthorizedError(input.error)) {
    return { state: { status: "anonymous" }, actions, meta };
  }

  // A visitor already confirmed anonymous stays anonymous while Better Auth
  // revalidates (window focus, another tab's sign-in announcement) and through
  // a failed revalidation, just as confirmed data survives one above. Only the
  // first load waits: otherwise every refocus would unmount whatever the
  // anonymous state renders (the sign-in form and its typed values).
  if (input.confirmedAnonymous && (input.error !== null || input.isPending)) {
    return { state: { status: "anonymous" }, actions, meta };
  }

  if (input.error !== null) {
    return { state: { status: "error" }, actions, meta };
  }

  if (input.isPending) {
    return { state: { status: "pending" }, actions, meta };
  }

  return { state: { status: "anonymous" }, actions, meta };
}

/**
 * The memory {@link AuthSessionStateInput.confirmedAnonymous} reads: true once
 * a snapshot settled anonymous, false again once one is authenticated, and
 * unchanged by pending and error snapshots.
 */
export function rememberConfirmedAnonymous(
  previous: boolean,
  state: AuthSessionStateValue<unknown>,
): boolean {
  if (state.status === "anonymous") return true;
  if (state.status === "authenticated") return false;
  return previous;
}
