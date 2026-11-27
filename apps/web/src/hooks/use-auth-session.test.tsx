import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const atom = vi.hoisted(() => ({
  viewError: null as { status: number } | null,
  pending: false,
  refetch: vi.fn(),
  snapshot: undefined as
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
    $store: { atoms: { session: { get: () => atom.snapshot } } },
    // The atom still holds the previous account (another tab switched).
    useSession: () => ({
      data: atom.viewError || atom.pending ? null : { user: { id: "a", name: "Previous Account" } },
      isPending: atom.pending,
      isRefetching: atom.pending,
      error: atom.viewError,
      refetch: atom.refetch,
    }),
  },
}));
vi.mock("./use-network-status", () => ({ useNetworkStatus: () => true }));
// Static rendering reads a store's server snapshot; read the client one, as
// the client-rendered app shell does.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));

const { readSessionIdentity, useAuthSession } = await import("./use-auth-session");
const { SessionUnconfirmed } = await import("@/lib/session-unconfirmed");

function Who() {
  const { state } = useAuthSession();
  return <span>{state.status === "authenticated" ? state.session.user.name : state.status}</span>;
}

describe("useAuthSession", () => {
  it("reports the atom's account outside the pending app shell", () => {
    expect(renderToStaticMarkup(<Who />)).toContain("Previous Account");
  });

  it("shows nobody under SessionUnconfirmed, before a guard admitted anyone", () => {
    const html = renderToStaticMarkup(
      <SessionUnconfirmed>
        <Who />
      </SessionUnconfirmed>,
    );
    expect(html).toContain("pending");
    expect(html).not.toContain("Previous Account");
  });

  it("shows nobody while another tab's identity change is unchecked here", async () => {
    const identity = await import("@/lib/document-identity");
    identity.resetDocumentIdentityForTests(() => ({ postMessage: () => {}, onmessage: null }));
    vi.stubGlobal("window", {});
    try {
      identity.announceDocumentIdentity("a"); // opens the document's channel
      identity.reportSessionRejected(); // no watcher mounted: unverified
      expect(identity.isDocumentIdentityUnverified()).toBe(true);
      expect(renderToStaticMarkup(<Who />)).not.toContain("Previous Account");
      identity.confirmDocumentIdentityFresh(identity.identityVerificationGeneration());
      expect(renderToStaticMarkup(<Who />)).toContain("Previous Account");
    } finally {
      vi.unstubAllGlobals();
      identity.resetDocumentIdentityForTests(() => undefined);
    }
  });

  it("reads only a successful, settled answer as a confirmed identity", () => {
    const snap = (over: Partial<NonNullable<typeof atom.snapshot>>) => {
      atom.snapshot = { data: null, error: null, isPending: false, isRefetching: false, ...over };
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
    atom.snapshot = undefined;
    expect(readSessionIdentity()).toBeUndefined();
  });
});

let retrySession: (() => Promise<void>) | undefined;
function RetrySession() {
  retrySession = useAuthSession().actions.retry;
  return null;
}

describe("failed initial session", () => {
  it("retains Retry's error state while a retry is pending", async () => {
    const { resetAuthSessionMemoryForTests } = await import("./use-auth-session");
    resetAuthSessionMemoryForTests();
    vi.stubGlobal("window", {});
    try {
      atom.viewError = { status: 429 };
      expect(renderToStaticMarkup(<Who />)).toContain("error");
      atom.viewError = null;
      atom.pending = true;
      expect(renderToStaticMarkup(<Who />)).toContain("error");
      atom.pending = false;
      expect(renderToStaticMarkup(<Who />)).toContain("Previous Account");
    } finally {
      atom.viewError = null;
      atom.pending = false;
      resetAuthSessionMemoryForTests();
      vi.unstubAllGlobals();
    }
  });
  it("a successful retry verifies a previously masked identity", async () => {
    const identity = await import("@/lib/document-identity");
    const postMessage = vi.fn();
    identity.resetDocumentIdentityForTests(() => ({ postMessage, onmessage: null }));
    vi.stubGlobal("window", {});
    atom.refetch.mockResolvedValue(undefined);
    atom.snapshot = {
      data: { user: { id: "a" } },
      error: null,
      isPending: false,
      isRefetching: false,
    };
    try {
      identity.observeDocumentIdentity("a");
      identity.reportSessionRejected();
      renderToStaticMarkup(<RetrySession />);
      expect(identity.isDocumentIdentityUnverified()).toBe(true);
      await retrySession?.();
      expect(identity.isDocumentIdentityUnverified()).toBe(false);
      expect(postMessage).toHaveBeenCalledWith({ kind: "identity", id: "a" });
    } finally {
      atom.snapshot = undefined;
      identity.resetDocumentIdentityForTests(() => undefined);
      vi.unstubAllGlobals();
    }
  });
  it("a retry superseded by an invalidation never confirms or announces its retained account", async () => {
    const identity = await import("@/lib/document-identity");
    const postMessage = vi.fn();
    identity.resetDocumentIdentityForTests(() => ({ postMessage, onmessage: null }));
    vi.stubGlobal("window", {});
    let finish!: () => void;
    atom.refetch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    atom.snapshot = {
      data: { user: { id: "a" } },
      error: null,
      isPending: false,
      isRefetching: false,
    };
    try {
      identity.observeDocumentIdentity(null);
      identity.reportSessionRejected();
      renderToStaticMarkup(<RetrySession />);
      const retry = retrySession?.();
      identity.reportSessionRejected();
      finish();
      await retry;
      expect(identity.isDocumentIdentityUnverified()).toBe(true);
      expect(postMessage).not.toHaveBeenCalled();
      expect(identity.withExpectedIdentity().has("X-Expected-User")).toBe(false);
    } finally {
      atom.snapshot = undefined;
      identity.resetDocumentIdentityForTests(() => undefined);
      vi.unstubAllGlobals();
    }
  });
  it("a peer announcement during a coalesced retry cannot unmask its stale account", async () => {
    const identity = await import("@/lib/document-identity");
    const peer = {
      postMessage: vi.fn(),
      onmessage: null as ((event: MessageEvent) => void) | null,
    };
    identity.resetDocumentIdentityForTests(() => peer);
    vi.stubGlobal("window", {});
    let finish!: () => void;
    atom.refetch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    atom.snapshot = {
      data: { user: { id: "a" } },
      error: null,
      isPending: false,
      isRefetching: false,
    };
    try {
      identity.observeDocumentIdentity("a");
      renderToStaticMarkup(<RetrySession />);
      const check = vi.fn(() => retrySession?.());
      identity.connectIdentityPeers(check);
      peer.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
      const pending = check.mock.results[0]?.value;
      peer.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
      finish();
      await pending;
      expect(identity.isDocumentIdentityUnverified()).toBe(true);
      expect(renderToStaticMarkup(<Who />)).not.toContain("Previous Account");
      expect(peer.postMessage).not.toHaveBeenCalled();
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      atom.snapshot = undefined;
      identity.resetDocumentIdentityForTests(() => undefined);
      vi.unstubAllGlobals();
    }
  });
});
