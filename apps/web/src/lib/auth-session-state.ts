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

  if (input.error !== null) {
    return { state: { status: "error" }, actions, meta };
  }

  if (input.isPending) {
    return { state: { status: "pending" }, actions, meta };
  }

  return { state: { status: "anonymous" }, actions, meta };
}
