import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionUnconfirmed } from "@/lib/session-unconfirmed";

import {
  readSessionIdentity,
  resetAuthSessionMemoryForTests,
  useAuthSession,
} from "./use-auth-session";

const atom = vi.hoisted(() => ({
  // Better Auth's atom still holds the previous account.
  snapshot: {
    data: { user: { id: "a", name: "Ada" } } as { user: { id: string; name: string } } | null,
    isPending: false,
    isRefetching: false,
    error: null as unknown,
  },
  /** What `$store.atoms.session.get()` returns (`readSessionIdentity`). */
  store: undefined as
    | {
        data: { user: { id: string } } | null;
        error: { status?: number } | null;
        isPending: boolean;
        isRefetching: boolean;
      }
    | undefined,
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ ...atom.snapshot, refetch: vi.fn() }),
    $store: { atoms: { session: { get: () => atom.store } } },
  },
}));
vi.mock("./use-network-status", () => ({ useNetworkStatus: () => true }));
// Static rendering reads a store's server snapshot; read the client one, as
// the client-rendered app shell does.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));

function Raw() {
  const { state } = useAuthSession({ unmasked: true });
  return <>{state.status === "authenticated" ? state.session.user.id : state.status}</>;
}

function Status() {
  const { state } = useAuthSession();
  return <>{state.status === "authenticated" ? state.session.user.id : state.status}</>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetAuthSessionMemoryForTests();
  atom.snapshot = {
    data: { user: { id: "a", name: "Ada" } },
    isPending: false,
    isRefetching: false,
    error: null,
  };
});

describe("useAuthSession", () => {
  it("reports the atom's session", () => {
    expect(renderToStaticMarkup(<Status />)).toBe("a");
  });

  it("names nobody under SessionUnconfirmed (the app shell's pending state)", () => {
    expect(
      renderToStaticMarkup(
        <SessionUnconfirmed>
          <Status />
        </SessionUnconfirmed>,
      ),
    ).toBe("pending");
  });

  it("keeps the pending shell pending even after this document settled signed out", () => {
    // The browser remembers a settled anonymous session (refocus refetches
    // stay anonymous), but under SessionUnconfirmed nobody is known yet, and
    // what renders there must not teach the memory anything either.
    vi.stubGlobal("window", {});
    atom.snapshot = { data: null, isPending: false, isRefetching: false, error: null };
    expect(renderToStaticMarkup(<Status />)).toBe("anonymous");
    atom.snapshot = { data: null, isPending: true, isRefetching: true, error: null };
    expect(renderToStaticMarkup(<Status />)).toBe("anonymous");
    expect(
      renderToStaticMarkup(
        <SessionUnconfirmed>
          <Status />
        </SessionUnconfirmed>,
      ),
    ).toBe("pending");
    // A session confirmed under the pending shell is not taken as "signed in"
    // either, so the memory still holds for the page after it.
    atom.snapshot = {
      data: { user: { id: "b", name: "Bo" } },
      isPending: false,
      isRefetching: false,
      error: null,
    };
    expect(
      renderToStaticMarkup(
        <SessionUnconfirmed>
          <Status />
        </SessionUnconfirmed>,
      ),
    ).toBe("pending");
    atom.snapshot = { data: null, isPending: true, isRefetching: true, error: null };
    expect(renderToStaticMarkup(<Status />)).toBe("anonymous");
  });

  it("names nobody while another tab's identity change is unchecked here", async () => {
    const identity = await import("@/lib/document-identity");
    identity.resetDocumentIdentityForTests(() => ({ postMessage: () => {}, onmessage: null }));
    vi.stubGlobal("window", {});
    try {
      identity.announceDocumentIdentity("a"); // opens the document's channel
      identity.reportSessionRejected(); // no watcher mounted: unverified
      expect(identity.isDocumentIdentityUnverified()).toBe(true);
      expect(renderToStaticMarkup(<Status />)).toBe("pending");
      // The watcher alone reads the raw session.
      expect(renderToStaticMarkup(<Raw />)).toBe("a");
      identity.confirmDocumentIdentityFresh(identity.identityVerificationGeneration());
      expect(renderToStaticMarkup(<Status />)).toBe("a");
    } finally {
      identity.resetDocumentIdentityForTests(() => undefined);
    }
  });

  it("reads only a successful, settled answer as a confirmed identity", () => {
    const snap = (over: Partial<NonNullable<typeof atom.store>>) => {
      atom.store = { data: null, error: null, isPending: false, isRefetching: false, ...over };
      return readSessionIdentity();
    };
    expect(snap({ data: { user: { id: "b" } } })).toBe("b");
    expect(snap({})).toBeNull();
    // A 401 confirms the session is gone.
    expect(snap({ error: { status: 401 } })).toBeNull();
    // A 503 confirms nothing: not with A's answer retained, not when the
    // document was (remembered) anonymous.
    expect(snap({ data: { user: { id: "a" } }, error: { status: 503 } })).toBeUndefined();
    expect(snap({ error: { status: 503 } })).toBeUndefined();
    // In flight: not yet an answer.
    expect(snap({ data: { user: { id: "a" } }, isRefetching: true })).toBeUndefined();
    expect(snap({ isPending: true })).toBeUndefined();
    atom.store = undefined;
    expect(readSessionIdentity()).toBeUndefined();
  });
});
