import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock, mounted } = vi.hoisted(() => {
  const fetchMock = vi.fn<typeof fetch>();
  // Better Fetch captures its transport when the client is constructed.
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    mounted: {
      cleanups: [] as (() => void)[],
      refetch: vi.fn(),
      readIdentity: vi.fn<() => string | null | undefined>(),
      nativeIdentity: false,
    },
  };
});

// Mount the app-shell watcher's effects, as in its colocated hook harness.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useLayoutEffect: (effect: () => (() => void) | undefined) => {
    const cleanup = effect();
    if (cleanup) mounted.cleanups.push(cleanup);
  },
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({
    state: { status: "authenticated", session: { user: { id: "a" } } },
    actions: { refetch: mounted.refetch },
    meta: {},
  }),
  readSessionIdentity: () => mounted.readIdentity(),
  readSessionIdentityGeneration: () =>
    mounted.nativeIdentity ? readSessionIdentityGeneration() : identityVerificationGeneration(),
  isSessionFetchInFlight: () => false,
}));

vi.mock("@knowledge-base/env/web", () => ({ env: { VITE_SERVER_URL: "https://app.test" } }));
vi.mock("@/i18n", () => ({ default: { language: "es-MX" } }));

import { MutationCache, QueryClient } from "@tanstack/react-query";
import { useReloadOnIdentityChange } from "@/hooks/use-reload-on-identity-change";
import { orpc } from "@/utils/orpc";
import { authClient, readSessionIdentityGeneration } from "./auth-client";
import {
  admitRouteIdentity,
  identityVerificationGeneration,
  isDocumentIdentityUnverified,
  isDocumentReplaced,
  markExplicitSignOut,
  onDocumentReplaced,
  replaceDocument,
  resetDocumentIdentityForTests,
  sealQueryClient,
  skipErrorToastForIdentity,
} from "./document-identity";
import {
  connectSessionRetry,
  observeSessionRetry,
  resetSessionRetryForTests,
} from "./session-retry";

const reload = vi.fn();
let messages: unknown[];
let peer: {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
};
let nativeClock = Date.UTC(2030, 0, 1);
let cleanupNative: (() => Promise<void>) | undefined;
beforeEach(async () => {
  resetSessionRetryForTests();
  messages = [];
  peer = {
    onmessage: null,
    postMessage: (message) => messages.push(message),
  };
  resetDocumentIdentityForTests(() => peer);
  reload.mockReset();
  const events = new EventTarget();
  const target = {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  };
  vi.stubGlobal("window", { ...target, location: { reload, pathname: "/en-US/settings/profile" } });
  vi.stubGlobal("document", { ...target, documentElement: { style: { setProperty: vi.fn() } } });
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset().mockResolvedValue(Response.json({ success: true }));
  await admitRouteIdentity({ status: "resolved", session: { user: { id: "a" } } });
  mounted.cleanups = [];
  mounted.nativeIdentity = false;
  mounted.refetch.mockReset();
  mounted.readIdentity.mockReset().mockReturnValue("a");
  useReloadOnIdentityChange();
});
afterEach(async () => {
  for (const cleanup of mounted.cleanups) cleanup();
  await cleanupNative?.();
  cleanupNative = undefined;
  vi.unstubAllGlobals();
  resetSessionRetryForTests();
});

async function settle() {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
function headers(): Headers {
  const [input, init] = fetchMock.mock.calls.at(-1) ?? [];
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}

describe("authClient identity transport", () => {
  it.each(["b", "a", null])(
    "probes an obsolete settled atom after a guard clears the mask, fresh answer %s",
    async (freshIdentity) => {
      vi.useFakeTimers();
      nativeClock += 120_000;
      vi.setSystemTime(nativeClock);
      vi.stubGlobal("navigator", { onLine: true });
      Object.assign(document, { visibilityState: "visible" });
      for (const cleanup of mounted.cleanups) cleanup();
      mounted.cleanups = [];
      resetDocumentIdentityForTests(() => peer);
      mounted.nativeIdentity = true;
      await admitRouteIdentity({ status: "resolved", session: null });
      const session = authClient.$store.atoms.session;
      if (!session) throw new Error("Missing Better Auth session atom");
      mounted.refetch.mockImplementation(() => session.get().refetch());
      mounted.readIdentity.mockImplementation(() => {
        const snapshot = session.get();
        return snapshot.isPending || snapshot.isRefetching || snapshot.error
          ? undefined
          : (snapshot.data?.user.id ?? null);
      });
      let respond!: (response: Response) => void;
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve;
          }),
      );
      const unsubscribe = session.subscribe(() => {});
      cleanupNative = async () => {
        respond?.(Response.json(null));
        unsubscribe();
        await vi.advanceTimersByTimeAsync(1_000);
        vi.useRealTimers();
      };
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      peer.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
      // A's pre-announcement answer settles with no watcher mounted.
      respond(Response.json({ user: { id: "a" }, session: { id: "old" } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(session.get().data?.user.id).toBe("a");
      expect(readSessionIdentityGeneration()).not.toBe(identityVerificationGeneration());
      await admitRouteIdentity({ status: "resolved", session: { user: { id: "b" } } });
      expect(isDocumentIdentityUnverified()).toBe(false);
      // The fresh guard admitted B, but Better Auth still retains A.
      useReloadOnIdentityChange();
      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mounted.refetch).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
      respond(
        Response.json(
          freshIdentity === null ? null : { user: { id: freshIdentity }, session: { id: "fresh" } },
        ),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reload).toHaveBeenCalledTimes(freshIdentity === "b" ? 0 : 1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mounted.refetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["a", "b"])(
    "rejects a pre-announcement native answer and runs one fresh probe answering %s",
    async (freshIdentity) => {
      vi.useFakeTimers();
      nativeClock += 120_000;
      vi.setSystemTime(nativeClock);
      vi.stubGlobal("navigator", { onLine: true });
      Object.assign(document, { visibilityState: "visible" });
      fetchMock.mockImplementation(async () =>
        Response.json({ user: { id: "a" }, session: { id: "s" } }),
      );
      const session = authClient.$store.atoms.session;
      if (!session) throw new Error("Missing Better Auth session atom");
      mounted.refetch.mockImplementation(() => session.get().refetch());
      mounted.readIdentity.mockImplementation(() => {
        const snapshot = session.get();
        return snapshot.isPending || snapshot.isRefetching || snapshot.error
          ? undefined
          : (snapshot.data?.user.id ?? null);
      });
      const unsubscribe = session.subscribe(() => {});
      let respond!: (response: Response) => void;
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const response = new Promise<Response>((resolve) => {
          respond = resolve;
        });
        fetchMock.mockImplementation(() => response);
        // Start Better Auth's actual cross-tab refresh before the peer's
        // subsequent switch to B and BroadcastChannel announcements.
        window.dispatchEvent(
          Object.assign(new Event("storage"), {
            key: "better-auth.message",
            newValue: JSON.stringify({ event: "session", data: { trigger: "signout" } }),
          }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const nativeSignal = fetchMock.mock.calls.at(-1)?.[1]?.signal;
        peer.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
        peer.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(nativeSignal?.aborted).toBe(false);
        expect(mounted.refetch).not.toHaveBeenCalled();
        expect(reload).not.toHaveBeenCalled();
        let respondFresh!: (response: Response) => void;
        fetchMock.mockImplementation(
          () =>
            new Promise<Response>((resolve) => {
              respondFresh = resolve;
            }),
        );
        // The native request read A before the peer switched to B.
        respond(Response.json({ user: { id: "a" }, session: { id: "s" } }));
        await vi.advanceTimersByTimeAsync(0);
        expect(isDocumentIdentityUnverified()).toBe(true);
        expect(reload).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(mounted.refetch).toHaveBeenCalledTimes(1);
        respondFresh(Response.json({ user: { id: freshIdentity }, session: { id: "fresh" } }));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(reload).toHaveBeenCalledTimes(freshIdentity === "b" ? 1 : 0);
        if (freshIdentity === "a") expect(isDocumentIdentityUnverified()).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(mounted.refetch).toHaveBeenCalledTimes(1);
      } finally {
        respond?.(Response.json(null));
        unsubscribe();
        await vi.advanceTimersByTimeAsync(1_000);
        vi.useRealTimers();
      }
    },
  );
  it.each(["visibilitychange", "online"])(
    "real Better Auth %s refresh honors a 60-second Retry-After",
    async (event) => {
      vi.useFakeTimers();
      // The real atom survives tests. Move past its short successful-mount
      // dedupe window so each mount makes its initial request.
      nativeClock += 120_000;
      vi.setSystemTime(nativeClock);
      vi.stubGlobal("navigator", { onLine: true });
      Object.assign(document, { visibilityState: "visible" });
      fetchMock
        .mockResolvedValueOnce(
          Response.json(
            { code: "RATE_LIMITED" },
            { status: 429, headers: { "Retry-After": "60" } },
          ),
        )
        .mockImplementation(async () => Response.json({ user: { id: "a" }, session: { id: "s" } }));
      const session = authClient.$store.atoms.session;
      if (!session) throw new Error("Missing Better Auth session atom");
      // Mount the REAL atom and its native refresh manager, not a refetch mock.
      const unsubscribe = session.subscribe((snapshot) => {
        observeSessionRetry(snapshot.error, snapshot.isPending || snapshot.isRefetching);
      });
      const disconnect = connectSessionRetry(() => session.get().refetch());
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(session.get().error?.status).toBe(429);
        await vi.advanceTimersByTimeAsync(6_000); // past Better Auth's own 5s throttle
        if (event === "online") window.dispatchEvent(new Event("offline"));
        else {
          Object.assign(document, { visibilityState: "hidden" });
          document.dispatchEvent(new Event("visibilitychange"));
          Object.assign(document, { visibilityState: "visible" });
        }
        (event === "online" ? window : document).dispatchEvent(new Event(event));
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(53_999);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(session.get().error).toBeNull();
      } finally {
        disconnect();
        unsubscribe();
        await vi.advanceTimersByTimeAsync(1_000); // nanostores' deferred unmount
        vi.useRealTimers();
      }
    },
  );

  it("announces this tab's session signal before navigation", () => {
    authClient.$store.notify("$sessionSignal");
    expect(messages.at(-1)).toEqual({ kind: "session-changed" });
  });
  it("attaches the admitted owner and live locale to Better Auth writes", async () => {
    await authClient.updateUser({ name: "A's name" });
    expect(headers().get("X-Expected-User")).toBe("a");
    expect(headers().get("X-App-Locale")).toBe("es-MX");
  });
  it.each(["get-session", "sign-out"])("does not attach an owner to %s", async (endpoint) => {
    await authClient.$fetch(`/${endpoint}`);
    expect(headers().has("X-Expected-User")).toBe(false);
  });
  it("an unannounced cookie switch refuses updateUser without a toast or form error", async () => {
    fetchMock.mockResolvedValue(Response.json({ code: "IDENTITY_CHANGED" }, { status: 409 }));
    const formError = vi.fn();
    const toast = vi.fn();
    const onError = vi.fn();
    const save = authClient
      .updateUser({ name: "A's name", fetchOptions: { onError } })
      .then((result) => {
        if (result.error) {
          formError(result.error);
          toast(result.error);
        }
      })
      .catch(formError);
    let completed = false;
    void save.then(() => {
      completed = true;
    });
    await settle();
    expect(headers().get("X-Expected-User")).toBe("a");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(isDocumentReplaced()).toBe(true);
    expect(completed).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    expect(formError).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no session probe
  });
  it("an oRPC mutation rejects an unannounced cookie switch before callbacks", async () => {
    fetchMock.mockResolvedValue(Response.json({ code: "IDENTITY_CHANGED" }, { status: 409 }));
    const toast = vi.fn();
    const client = new QueryClient({
      mutationCache: new MutationCache({
        onError(error) {
          if (!skipErrorToastForIdentity(error, "mutation")) toast(error);
        },
      }),
    });
    onDocumentReplaced(() => sealQueryClient(client));
    client.setQueryData(["profile"], { name: "A's name" });
    const formError = vi.fn();
    const success = vi.fn();
    const mutation = client.getMutationCache().build(client, {
      ...orpc.settings.updateMyNotificationPreferences.mutationOptions(),
      onError: formError,
      onSuccess: success,
    });
    void mutation.execute({ operationalAlerts: true }).catch(formError);
    await settle();
    expect(headers().get("X-Expected-User")).toBe("a");
    expect(headers().has("x-csrf-token")).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(["profile"])).toBeUndefined();
    expect(toast).not.toHaveBeenCalled();
    expect(formError).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("lets an explicit sign-out finish after a peer replaced the document", async () => {
    markExplicitSignOut();
    replaceDocument();
    const success = vi.fn();
    await authClient.signOut({ fetchOptions: { onSuccess: success } });
    expect(success).toHaveBeenCalledTimes(1);
  });
  it("keeps unrelated 409s as ordinary form errors", async () => {
    fetchMock.mockResolvedValue(Response.json({ code: "OTHER_CONFLICT" }, { status: 409 }));
    const result = await authClient.updateUser({ name: "name" });
    expect(result.error?.code).toBe("OTHER_CONFLICT");
    expect(reload).not.toHaveBeenCalled();
  });
});
