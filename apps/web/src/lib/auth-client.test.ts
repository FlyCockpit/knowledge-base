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
  vi.useFakeTimers();
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
  resetSessionRetryForTests();
  vi.useFakeTimers();
  authClient.$store.atoms.session?.off();
  await vi.advanceTimersByTimeAsync(1_000);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function settle() {
  if (vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 30; i++) await Promise.resolve();
  } else {
    for (let i = 0; i < 30; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  }
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
      // The outside-app probe already owns the fresh coordinator slot.
      expect(mounted.refetch).not.toHaveBeenCalled();
      expect(reload).not.toHaveBeenCalled();
      respond(
        Response.json(
          freshIdentity === null ? null : { user: { id: freshIdentity }, session: { id: "fresh" } },
        ),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reload).toHaveBeenCalledTimes(freshIdentity === "b" ? 0 : 1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The outside-app probe already owns the fresh coordinator slot.
      expect(mounted.refetch).not.toHaveBeenCalled();
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

describe("follow-up session reconciliation", () => {
  it.each(["/en-US/", "/en-US/missing"])(
    "a fresh public document at %s listens without an initial probe and lazily reconciles a peer sign-in",
    async (pathname) => {
      for (const cleanup of mounted.cleanups.splice(0)) cleanup();
      resetDocumentIdentityForTests(() => peer);
      Object.assign(window.location, { pathname });
      const { watchDocumentRestore } = await import("./document-identity");
      watchDocumentRestore();
      expect(fetchMock).not.toHaveBeenCalled();
      fetchMock.mockResolvedValue(
        Response.json({ user: { id: "b" }, session: { expiresAt: "2099-01-01T00:00:00.000Z" } }),
      );
      peer.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/get-session");
      expect(reload).toHaveBeenCalledTimes(1);
    },
  );

  it("a retained A document on a public page reconciles B after its app watcher unmounts", async () => {
    for (const cleanup of mounted.cleanups.splice(0)) cleanup();
    Object.assign(window.location, { pathname: "/en-US/" });
    fetchMock.mockResolvedValue(
      Response.json({ user: { id: "b" }, session: { expiresAt: "2099-01-01T00:00:00.000Z" } }),
    );
    peer.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a private401 bypasses a revoked cookie cache once; ordinary refreshes keep the cache", async () => {
    const { reportSessionRejected, needsAuthoritativeSessionCheck } = await import(
      "./document-identity"
    );
    const urls: URL[] = [];
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      // Mirrors Better Auth's get-session shouldUseCookieCache decision:
      // the cached A session survives revocation until authoritative lookup.
      return Response.json(
        url.searchParams.get("disableCookieCache") === "true"
          ? null
          : { user: { id: "a" }, session: { expiresAt: "2099-01-01T00:00:00.000Z" } },
      );
    });
    const ordinary = await authClient.getSession();
    expect(ordinary.data?.user.id).toBe("a");
    expect(urls[0]?.searchParams.has("disableCookieCache")).toBe(false);
    mounted.refetch.mockImplementation(async () => {
      const answer = await authClient.getSession();
      mounted.readIdentity.mockReturnValue(answer.data?.user.id ?? null);
    });
    reportSessionRejected();
    reportSessionRejected();
    await settle();
    expect(urls).toHaveLength(2);
    expect(urls[1]?.searchParams.get("disableCookieCache")).toBe("true");
    expect(needsAuthoritativeSessionCheck()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a401 cannot share a pre-rejection A answer, even while a peer probe is pending", async () => {
    const { reportSessionRejected } = await import("./document-identity");
    let finish!: () => void;
    mounted.refetch
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockImplementationOnce(async () => {
        const answer = await authClient.getSession();
        mounted.readIdentity.mockReturnValue(answer.data?.user.id ?? null);
      });
    peer.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    await settle();
    reportSessionRejected();
    mounted.readIdentity.mockReturnValue("a");
    fetchMock.mockResolvedValue(Response.json(null));
    finish();
    await settle();
    // Existing bounded follow-up timer, not a second rejection scheduler.
    await vi.advanceTimersByTimeAsync(260);
    await settle();
    expect(mounted.refetch).toHaveBeenCalledTimes(2);
    expect(
      new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("disableCookieCache"),
    ).toBe("true");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("failed authoritative checks retain the bypass and Retry-After coalescing", async () => {
    const { reportSessionRejected, needsAuthoritativeSessionCheck } = await import(
      "./document-identity"
    );
    const { recordSessionRetryAfter } = await import("./session-retry");
    mounted.refetch.mockImplementation(async () => {
      const answer = await authClient.getSession();
      mounted.readIdentity.mockReturnValue(answer.error ? undefined : "a");
    });
    fetchMock.mockResolvedValue(
      Response.json({ message: "busy" }, { status: 429, headers: { "Retry-After": "60" } }),
    );
    reportSessionRejected();
    await settle();
    expect(needsAuthoritativeSessionCheck()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    recordSessionRetryAfter(new Response(null, { status: 429, headers: { "Retry-After": "60" } }));
    reportSessionRejected();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("lazy verifier lifecycle", () => {
  it("recovers a public429 using the scheduler without recursively waiting on itself", async () => {
    for (const cleanup of mounted.cleanups.splice(0)) cleanup();
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ message: "busy" }, { status: 429, headers: { "Retry-After": "2" } }),
      )
      .mockResolvedValue(
        Response.json({ user: { id: "b" }, session: { expiresAt: "2099-01-01T00:00:00.000Z" } }),
      );
    try {
      peer.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_001); // scheduler backoff and Retry-After
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an app mounting during a public probe joins the updated atom instead of accepting old A", async () => {
    for (const cleanup of mounted.cleanups.splice(0)) cleanup();
    let answer!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    );
    peer.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
    await settle();
    mounted.readIdentity.mockImplementation(
      () => authClient.$store.atoms.session?.value.data?.user.id ?? null,
    );
    useReloadOnIdentityChange();
    answer(
      Response.json({ user: { id: "b" }, session: { expiresAt: "2099-01-01T00:00:00.000Z" } }),
    );
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(isDocumentReplaced()).toBe(true);
  });

  it("a valid authoritative same-A answer does not log out and subsequent probes keep normal cookie caching", async () => {
    const { reportSessionRejected } = await import("./document-identity");
    fetchMock.mockImplementation(async () =>
      Response.json({ user: { id: "a" }, session: { expiresAt: "2099-01-01T00:00:00.000Z" } }),
    );
    mounted.refetch.mockImplementation(async () => {
      const answer = await authClient.getSession();
      mounted.readIdentity.mockReturnValue(answer.data?.user.id ?? null);
    });
    reportSessionRejected();
    await settle();
    expect(
      new URL(String(fetchMock.mock.calls[0]?.[0])).searchParams.get("disableCookieCache"),
    ).toBe("true");
    expect(reload).not.toHaveBeenCalled();
    await authClient.getSession();
    expect(
      new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.has("disableCookieCache"),
    ).toBe(false);
  });
});

describe("production decoded RPC401 and QueryCache path", () => {
  it.each([false, true])(
    "reconciles first401 before retries (batched=%s), deduplicating final cache callbacks and burst errors",
    async (batched) => {
      const { ORPCError, os } = await import("@orpc/server");
      const { RPCHandler } = await import("@orpc/server/fetch");
      const { BatchHandlerPlugin } = await import("@orpc/server/plugins");
      const { QueryCache } = await import("@tanstack/react-query");
      const { retryQueryAfterFailure, identityVerificationGeneration } = await import(
        "./document-identity"
      );
      const procedure = vi.fn(() => {
        throw new ORPCError("UNAUTHORIZED");
      });
      const handler = new RPCHandler(
        { settings: { getAll: os.handler(procedure), adminSetupStatus: os.handler(procedure) } },
        {
          plugins: [new BatchHandlerPlugin()],
        },
      );
      let finishOld!: () => void;
      mounted.refetch
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finishOld = resolve;
            }),
        )
        .mockImplementation(async () => {
          const result = await authClient.getSession();
          mounted.readIdentity.mockReturnValue(result.data?.user.id ?? null);
        });
      // An A check predates the private rejection and cannot certify it.
      window.dispatchEvent(new Event("focus"));
      await settle();
      expect(mounted.refetch).toHaveBeenCalledTimes(1);
      const since = identityVerificationGeneration();
      const rpcUrls: string[] = [];
      const sessionUrls: URL[] = [];
      fetchMock.mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        if (request.url.includes("/get-session")) {
          sessionUrls.push(new URL(request.url));
          return Response.json(null);
        }
        rpcUrls.push(request.url);
        const result = await handler.handle(request, { prefix: "/rpc" });
        if (!result.response) throw new Error("Unmatched fixture RPC");
        return result.response;
      });
      const errors = vi.fn((error: unknown) => skipErrorToastForIdentity(error, "query"));
      const client = new QueryClient({
        defaultOptions: { queries: { retry: retryQueryAfterFailure } },
        queryCache: new QueryCache({ onError: errors }),
      });
      const first = client.fetchQuery({
        ...orpc.settings.getAll.queryOptions(),
        meta: { skipGlobalErrorToast: true },
      });
      const requests = batched
        ? [first, client.fetchQuery(orpc.settings.adminSetupStatus.queryOptions())]
        : [first];
      const settled = Promise.allSettled(requests);
      await vi.advanceTimersByTimeAsync(0);
      await settled;
      expect(procedure).toHaveBeenCalledTimes(batched ? 2 : 1);
      expect(errors).toHaveBeenCalledTimes(batched ? 2 : 1);
      expect(rpcUrls).toHaveLength(1);
      expect(rpcUrls[0]?.includes("/__batch__")).toBe(batched);
      expect(identityVerificationGeneration()).toBe(since + 1);
      finishOld();
      await settle();
      expect(mounted.refetch).toHaveBeenCalledTimes(2);
      expect(sessionUrls).toHaveLength(1);
      expect(sessionUrls[0]?.searchParams.get("disableCookieCache")).toBe("true");
      expect(reload).toHaveBeenCalledTimes(1);
      client.clear();
    },
  );

  it("preserves normal non401 query retries", async () => {
    const { retryQueryAfterFailure } = await import("./document-identity");
    const client = new QueryClient({
      defaultOptions: { queries: { retry: retryQueryAfterFailure, retryDelay: 0 } },
    });
    const fetchData = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary server failure"))
      .mockResolvedValue("ok");
    const result = client.fetchQuery({ queryKey: ["retry-network"], queryFn: fetchData });
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ok");
    expect(fetchData).toHaveBeenCalledTimes(2);
    client.clear();
  });
});

describe("public failure retry retained across app mount", () => {
  it("reconciles a scheduled B answer and seals A's cache after a successful app A check and a later failed peer check", async () => {
    for (const cleanup of mounted.cleanups.splice(0)) cleanup();
    let answer = "public-failure";
    fetchMock.mockImplementation(async () => {
      if (answer.endsWith("failure"))
        return Response.json({ message: "unavailable" }, { status: 503 });
      return Response.json({
        user: { id: answer },
        session: { expiresAt: "2099-01-01T00:00:00.000Z" },
      });
    });
    peer.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isDocumentIdentityUnverified()).toBe(true);

    mounted.readIdentity.mockImplementation(() => {
      const snapshot = authClient.$store.atoms.session?.value;
      return !snapshot || snapshot.error || snapshot.isRefetching
        ? undefined
        : (snapshot.data?.user.id ?? null);
    });
    mounted.refetch.mockImplementation(async () => {
      await authClient.$store.atoms.session?.value.refetch();
      const snapshot = authClient.$store.atoms.session?.value;
      observeSessionRetry(snapshot?.error, snapshot?.isPending || snapshot?.isRefetching || false);
    });
    answer = "a";
    useReloadOnIdentityChange();
    await settle();
    expect(mounted.refetch).toHaveBeenCalledTimes(1);
    expect(isDocumentIdentityUnverified()).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    const client = new QueryClient();
    onDocumentReplaced(() => sealQueryClient(client));
    client.setQueryData(["private-profile"], "A private data");
    answer = "watcher-failure";
    peer.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
    await settle();
    expect(mounted.refetch).toHaveBeenCalledTimes(2);
    expect(isDocumentIdentityUnverified()).toBe(true);
    answer = "b";
    await vi.advanceTimersByTimeAsync(4_000);
    await settle();
    // The retained raw public callback owns this scheduled slot. It must
    // reconcile even though an app watcher now exists, with no extra event.
    expect(mounted.refetch).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(["private-profile"])).toBeUndefined();
    client.setQueryData(["late-A-callback"], "A private data");
    expect(client.getQueryData(["late-A-callback"])).toBeUndefined();
  });
});

describe("delayed batch401 during an authoritative failure retry", () => {
  it.each(["a", "b", null])(
    "joins the scheduled %s probe without invalidating it or spending a third probe",
    async (freshIdentity) => {
      const { ORPCError, os } = await import("@orpc/server");
      const { RPCHandler } = await import("@orpc/server/fetch");
      const { BatchHandlerPlugin } = await import("@orpc/server/plugins");
      const { QueryCache } = await import("@tanstack/react-query");
      const { identityVerificationGeneration, retryQueryAfterFailure } = await import(
        "./document-identity"
      );
      let deliverSecond401!: () => void;
      const laterItem = new Promise<void>((resolve) => {
        deliverSecond401 = resolve;
      });
      const handler = new RPCHandler(
        {
          settings: {
            getAll: os.handler(() => {
              throw new ORPCError("UNAUTHORIZED");
            }),
            adminSetupStatus: os.handler(async () => {
              await laterItem;
              throw new ORPCError("UNAUTHORIZED");
            }),
          },
        },
        { plugins: [new BatchHandlerPlugin()] },
      );
      let completeRetry!: (response: Response) => void;
      const retryResponse = new Promise<Response>((resolve) => {
        completeRetry = resolve;
      });
      let probes = 0;
      fetchMock.mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        if (request.url.includes("/get-session")) {
          probes++;
          expect(new URL(request.url).searchParams.get("disableCookieCache")).toBe("true");
          return probes === 1
            ? Response.json({ message: "temporary" }, { status: 503 })
            : retryResponse;
        }
        const result = await handler.handle(request, { prefix: "/rpc" });
        if (!result.response) throw new Error("Unmatched fixture RPC");
        return result.response;
      });
      mounted.refetch.mockImplementation(async () => {
        const result = await authClient.getSession();
        mounted.readIdentity.mockReturnValue(
          result.error ? undefined : (result.data?.user.id ?? null),
        );
        observeSessionRetry(result.error, false);
      });
      mounted.cleanups.push(connectSessionRetry(mounted.refetch));
      const client = new QueryClient({
        defaultOptions: { queries: { retry: retryQueryAfterFailure } },
        queryCache: new QueryCache({
          onError: (error) => {
            skipErrorToastForIdentity(error, "query");
          },
        }),
      });
      const first = client.fetchQuery(orpc.settings.getAll.queryOptions());
      const second = client.fetchQuery(orpc.settings.adminSetupStatus.queryOptions());
      const both = Promise.allSettled([first, second]);
      await vi.advanceTimersByTimeAsync(0);
      expect(probes).toBe(1);
      const since = identityVerificationGeneration();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(probes).toBe(2);
      // The document-level hint callback has finished after its503, but the
      // coordinator's scheduled retry is in flight when the second item fails.
      deliverSecond401();
      await vi.advanceTimersByTimeAsync(0);
      await both;
      expect(identityVerificationGeneration()).toBe(since);
      completeRetry(
        Response.json(
          freshIdentity === null
            ? null
            : {
                user: { id: freshIdentity },
                session: { expiresAt: "2099-01-01T00:00:00.000Z" },
              },
        ),
      );
      await settle();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(probes).toBe(2);
      expect(reload).toHaveBeenCalledTimes(freshIdentity === "a" ? 0 : 1);
      if (freshIdentity === "a") expect(isDocumentIdentityUnverified()).toBe(false);
      client.clear();
    },
  );
});

describe("KB guarded and deferred document reconciliation", () => {
  it.each([
    ["focus", false],
    ["focus", true],
    ["online", false],
    ["online", true],
    ["visibilitychange", false],
    ["visibilitychange", true],
  ] as const)(
    "resumes a public Retry-After obligation on %s (early=%s) before any failed snapshot",
    async (event, early) => {
      for (const cleanup of mounted.cleanups.splice(0)) cleanup();
      resetDocumentIdentityForTests(() => peer);
      Object.assign(window.location, { pathname: "/en-US/missing" });
      Object.assign(document, { visibilityState: "visible" });
      vi.stubGlobal("navigator", { onLine: true });
      const { watchDocumentRestore } = await import("./document-identity");
      const { recordSessionRetryAfter } = await import("./session-retry");
      watchDocumentRestore();
      window.dispatchEvent(new Event("focus"));
      await settle();
      expect(fetchMock).not.toHaveBeenCalled();
      recordSessionRetryAfter(
        new Response(null, { status: 429, headers: { "Retry-After": "60" } }),
      );
      Object.assign(document, { visibilityState: "hidden" });
      peer.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
      await settle();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(isDocumentIdentityUnverified()).toBe(true);
      let respond!: (response: Response) => void;
      fetchMock.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            respond = resolve;
          }),
      );
      await vi.advanceTimersByTimeAsync(early ? 30_000 : 60_000);
      expect(fetchMock).not.toHaveBeenCalled();
      Object.assign(document, { visibilityState: "visible" });
      const target = event === "visibilitychange" ? document : window;
      target.dispatchEvent(new Event(event));
      await settle();
      if (early) {
        expect(fetchMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(29_999);
        expect(fetchMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      }
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      respond(
        Response.json({ user: { id: "b" }, session: { expiresAt: "2099-01-01T00:00:00.000Z" } }),
      );
      await settle();
      expect(reload).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("automatically checks a public Retry-After obligation at its deadline before any failure", async () => {
    for (const cleanup of mounted.cleanups.splice(0)) cleanup();
    resetDocumentIdentityForTests(() => peer);
    Object.assign(window.location, { pathname: "/en-US/missing" });
    Object.assign(document, { visibilityState: "visible" });
    vi.stubGlobal("navigator", { onLine: true });
    const { watchDocumentRestore } = await import("./document-identity");
    const { recordSessionRetryAfter } = await import("./session-retry");
    watchDocumentRestore();
    recordSessionRetryAfter(new Response(null, { status: 429, headers: { "Retry-After": "60" } }));
    fetchMock.mockResolvedValue(
      Response.json({ user: { id: "b" }, session: { expiresAt: "2099-01-01T00:00:00.000Z" } }),
    );
    peer.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it.each(["hidden", "offline"])(
    "resumes a public hint received while %s without a click",
    async (mode) => {
      for (const cleanup of mounted.cleanups.splice(0)) cleanup();
      resetDocumentIdentityForTests(() => peer);
      Object.assign(window.location, { pathname: "/en-US/missing" });
      Object.assign(document, { visibilityState: mode === "hidden" ? "hidden" : "visible" });
      vi.stubGlobal("navigator", { onLine: mode !== "offline" });
      const { watchDocumentRestore } = await import("./document-identity");
      watchDocumentRestore();
      fetchMock.mockResolvedValue(
        Response.json({ user: { id: "b" }, session: { expiresAt: "2099-01-01T00:00:00.000Z" } }),
      );
      peer.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
      await settle();
      expect(fetchMock).not.toHaveBeenCalled();
      Object.assign(document, { visibilityState: "visible" });
      vi.stubGlobal("navigator", { onLine: true });
      window.dispatchEvent(new Event(mode === "hidden" ? "focus" : "online"));
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["a", "b", null])(
    "does not admit a cached guard answer before authoritative %s settles",
    async (fresh) => {
      const { reportSessionRejected, needsAuthoritativeSessionCheck } = await import(
        "./document-identity"
      );
      let answer!: (response: Response) => void;
      fetchMock.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      );
      mounted.refetch.mockImplementation(async () => {
        const result = await authClient.getSession();
        mounted.readIdentity.mockReturnValue(
          result.error ? undefined : (result.data?.user.id ?? null),
        );
      });
      reportSessionRejected(Object.assign(new Error("revoked"), { status: 401 }));
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      let admitted = false;
      const guard = admitRouteIdentity(
        { status: "resolved", session: { user: { id: "a" } } },
        identityVerificationGeneration(),
      ).then(() => {
        admitted = true;
      });
      await settle();
      expect(admitted).toBe(false);
      expect(needsAuthoritativeSessionCheck()).toBe(true);
      answer(
        Response.json(
          fresh === null
            ? null
            : { user: { id: fresh }, session: { expiresAt: "2099-01-01T00:00:00.000Z" } },
        ),
      );
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(needsAuthoritativeSessionCheck()).toBe(false);
      if (fresh === "a") {
        await guard;
        expect(admitted).toBe(true);
        expect(reload).not.toHaveBeenCalled();
      } else {
        expect(admitted).toBe(false);
        expect(reload).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("keeps decoded403 as an ordinary retryable failure without invalidating identity", async () => {
    const { ORPCError, os } = await import("@orpc/server");
    const { RPCHandler } = await import("@orpc/server/fetch");
    const { QueryCache } = await import("@tanstack/react-query");
    const { retryQueryAfterFailure, needsAuthoritativeSessionCheck } = await import(
      "./document-identity"
    );
    const procedure = vi.fn(() => {
      throw new ORPCError("FORBIDDEN");
    });
    const handler = new RPCHandler({ settings: { getAll: os.handler(procedure) } });
    fetchMock.mockImplementation(async (input, init) => {
      const result = await handler.handle(new Request(input, init), { prefix: "/rpc" });
      if (!result.response) throw new Error("Unmatched fixture RPC");
      return result.response;
    });
    const errors = vi.fn((error: unknown) => skipErrorToastForIdentity(error, "query"));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: retryQueryAfterFailure, retryDelay: 0 } },
      queryCache: new QueryCache({ onError: errors }),
    });
    const generation = identityVerificationGeneration();
    const outcome = client.fetchQuery(orpc.settings.getAll.queryOptions()).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toMatchObject({ status: 403 });
    expect(procedure).toHaveBeenCalledTimes(4);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.results[0]?.value).toBe(false);
    expect(identityVerificationGeneration()).toBe(generation);
    expect(needsAuthoritativeSessionCheck()).toBe(false);
    expect(mounted.refetch).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    client.clear();
  });
});

describe("decoded failures without a QueryCache", () => {
  it.each([false, true])(
    "reconciles a direct private RPC401 immediately (batched=%s)",
    async (batched) => {
      const { ORPCError, os } = await import("@orpc/server");
      const { RPCHandler } = await import("@orpc/server/fetch");
      const { BatchHandlerPlugin } = await import("@orpc/server/plugins");
      const deny = () => {
        throw new ORPCError("UNAUTHORIZED");
      };
      const handler = new RPCHandler(
        { settings: { getAll: os.handler(deny), adminSetupStatus: os.handler(deny) } },
        { plugins: [new BatchHandlerPlugin()] },
      );
      const rpcRequests: Request[] = [];
      const sessionRequests: Request[] = [];
      fetchMock.mockImplementation(async (input, init) => {
        const request = new Request(input, init);
        if (request.url.includes("/get-session")) {
          sessionRequests.push(request);
          return Response.json(null);
        }
        rpcRequests.push(request);
        const result = await handler.handle(request, { prefix: "/rpc" });
        if (!result.response) throw new Error("Unmatched fixture RPC");
        return result.response;
      });
      mounted.refetch.mockImplementation(async () => {
        const result = await authClient.getSession();
        mounted.readIdentity.mockReturnValue(
          result.error ? undefined : (result.data?.user.id ?? null),
        );
      });
      const first = orpc.settings.getAll.call();
      const settled = Promise.allSettled(
        batched ? [first, orpc.settings.adminSetupStatus.call()] : [first],
      );
      await settle();
      expect((await settled).every((result) => result.status === "rejected")).toBe(true);
      expect(rpcRequests).toHaveLength(1);
      expect(rpcRequests[0]?.url.includes("/__batch__")).toBe(batched);
      expect(sessionRequests).toHaveLength(1);
      const sessionRequest = sessionRequests[0];
      if (!sessionRequest) throw new Error("Expected an authoritative session request");
      expect(new URL(sessionRequest.url).searchParams.get("disableCookieCache")).toBe("true");
      expect(mounted.refetch).toHaveBeenCalledTimes(1);
      expect(reload).toHaveBeenCalledTimes(1);
    },
  );

  it("does not turn a server decoded401 into browser document reconciliation", async () => {
    const { reportSessionRejected, needsAuthoritativeSessionCheck } = await import(
      "./document-identity"
    );
    const browser = window;
    vi.stubGlobal("window", undefined);
    try {
      reportSessionRejected(Object.assign(new Error("unauthorized"), { status: 401 }));
      expect(needsAuthoritativeSessionCheck()).toBe(false);
      expect(identityVerificationGeneration()).toBe(0);
    } finally {
      vi.stubGlobal("window", browser);
    }
    await settle();
    expect(mounted.refetch).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
