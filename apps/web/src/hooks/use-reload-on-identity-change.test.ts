import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  /** Last deps of each layout effect, by call order within one render. */
  deps: [] as (unknown[] | undefined)[],
  cleanups: [] as ((() => void) | undefined)[],
  call: 0,
  state: { status: "pending" } as
    | { status: "pending" }
    | { status: "error" }
    | { status: "anonymous" }
    | { status: "authenticated"; session: { user: { id: string } } },
  refetch: vi.fn(),
  reload: vi.fn(),
}));

// Run the hook without a DOM: layout effects that fire, in order, whenever
// their deps change (cleaning up the previous run first), as React does.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useLayoutEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const i = boundary.call++;
    const last = boundary.deps[i];
    if (last !== undefined && deps.every((dep, j) => dep === last[j])) return;
    boundary.deps[i] = deps;
    boundary.cleanups[i]?.();
    boundary.cleanups[i] = effect() ?? undefined;
  },
}));
vi.mock("@/hooks/use-auth-session", () => ({
  useAuthSession: () => ({ state: boundary.state, actions: { refetch: boundary.refetch } }),
}));

import { markExplicitSignOut, resetDocumentIdentityForTests } from "@/lib/document-identity";

import { sessionIdentity, useReloadOnIdentityChange } from "./use-reload-on-identity-change";

const user = (id: string) => ({ status: "authenticated", session: { user: { id } } }) as const;

function useRenderWith(state: typeof boundary.state) {
  boundary.state = state;
  boundary.call = 0;
  useReloadOnIdentityChange();
}

/** The `_app` shell unmounts (a public page): its effects clean up. */
function unmount() {
  for (const cleanup of boundary.cleanups) cleanup?.();
  boundary.deps = [];
  boundary.cleanups = [];
}

class FakeChannel {
  static open: FakeChannel[] = [];
  posted = 0;
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeChannel.open.push(this);
  }
  postMessage() {
    this.posted++;
  }
  close() {
    FakeChannel.open = FakeChannel.open.filter((c) => c !== this);
  }
}

beforeEach(() => {
  resetDocumentIdentityForTests();
  boundary.deps = [];
  boundary.cleanups = [];
  boundary.reload.mockReset();
  boundary.refetch.mockReset();
  FakeChannel.open = [];
  vi.stubGlobal("window", { location: { reload: boundary.reload } });
  vi.stubGlobal("BroadcastChannel", FakeChannel);
});
afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

describe("sessionIdentity", () => {
  it("maps session states to identities", () => {
    expect(sessionIdentity(user("u1"))).toBe("u1");
    expect(sessionIdentity({ status: "anonymous" })).toBeNull();
    expect(sessionIdentity({ status: "pending" })).toBeUndefined();
    expect(sessionIdentity({ status: "error" })).toBeUndefined();
  });
});

describe("useReloadOnIdentityChange", () => {
  it("does not reload on the first known identity or on sign-in", () => {
    useRenderWith({ status: "pending" });
    useRenderWith({ status: "anonymous" });
    useRenderWith(user("u1"));
    expect(boundary.reload).not.toHaveBeenCalled();
  });

  it("does not reload when a pending or error blip resolves to the same user", () => {
    useRenderWith(user("u1"));
    useRenderWith({ status: "error" });
    useRenderWith({ status: "pending" });
    useRenderWith(user("u1"));
    expect(boundary.reload).not.toHaveBeenCalled();
  });

  it("A → sign-out elsewhere → B: replaces the document at the sign-out", () => {
    useRenderWith(user("a"));
    useRenderWith({ status: "anonymous" });
    expect(boundary.reload).toHaveBeenCalledTimes(1);
    useRenderWith(user("b"));
    expect(boundary.reload).toHaveBeenCalledTimes(2);
  });

  it("A → B directly: replaces the document", () => {
    useRenderWith(user("a"));
    useRenderWith({ status: "pending" });
    useRenderWith(user("b"));
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("remembers whose data is cached across an `_app` unmount", () => {
    useRenderWith(user("a"));
    unmount();
    // Another account signed in while a public page was open.
    useRenderWith(user("b"));
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("leaves an explicit sign-out's own page load alone, until it is undone", () => {
    useRenderWith(user("u1"));
    const undo = markExplicitSignOut();
    useRenderWith({ status: "error" });
    useRenderWith(user("u1"));
    expect(boundary.reload).not.toHaveBeenCalled();
    undo();
    useRenderWith({ status: "anonymous" });
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("tells the other tabs about a sign-in, and checks the session on theirs", () => {
    useRenderWith({ status: "anonymous" });
    const [channel] = FakeChannel.open;
    expect(channel?.posted).toBe(1);
    useRenderWith(user("a"));
    expect(channel?.posted).toBe(2);
    useRenderWith(user("a"));
    expect(channel?.posted).toBe(2);
    channel?.onmessage?.({} as MessageEvent);
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    // The channel is the document's, not the shell's: it stays open.
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    expect(FakeChannel.open).toHaveLength(1);
  });
});
