import { authClient } from "@/lib/auth-client";
import { type AuthSessionState, getAuthSessionState } from "@/lib/auth-session-state";
import { useSessionUnconfirmed } from "@/lib/session-unconfirmed";

import { useNetworkStatus } from "./use-network-status";

/** Read the same live atom as the adapter, including after an owner unmounts. */
export function getAuthActorKey(): string | null {
  const userId = authClient.$store.atoms.session?.get().data?.user.id;
  return userId ? `user:${userId}` : null;
}

/** The sole application adapter for Better Auth's reactive session atom. */
export function useAuthSession(): AuthSessionState {
  const session = authClient.useSession();
  const isOnline = useNetworkStatus();
  // Under `SessionUnconfirmed` (the app shell's pending state): nobody yet.
  const unconfirmed = useSessionUnconfirmed();

  return getAuthSessionState({
    data: unconfirmed ? null : session.data,
    isPending: unconfirmed || session.isPending,
    isRefetching: session.isRefetching,
    error: unconfirmed ? null : session.error,
    isOnline,
    refetch: session.refetch,
  });
}
