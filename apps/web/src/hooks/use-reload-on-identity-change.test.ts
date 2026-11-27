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
  /** What the atom holds right after a refetch (`readSessionIdentity`). */
  checked: undefined as string | null | undefined,
  refetching: false,
  degraded: false,
  inFlight: false,
  /** The hook's refs, by call order, kept across renders of one mount. */
  refs: [] as { current: unknown }[],
  refCall: 0,
}));

// Run the hook without a DOM: layout effects that fire, in order, whenever
// their deps change (cleaning up the previous run first), as React does.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: (initial: unknown) => {
    const i = boundary.refCall++;
    boundary.refs[i] ??= { current: initial };
    return boundary.refs[i];
  },
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
  useAuthSession: (options?: { unmasked?: boolean }) => ({
    // The watcher must read the raw session: a masked read here would see
    // only `pending`, and every identity test below would fail.
    state: options?.unmasked === true ? boundary.state : { status: "pending" },
    actions: { refetch: boundary.refetch },
    meta: { isRefetching: boundary.refetching, isDegraded: boundary.degraded },
  }),
  readSessionIdentity: () => boundary.checked,
  isSessionFetchInFlight: () => boundary.inFlight,
}));

import {
  admitRouteIdentity,
  isDocumentIdentityUnverified,
  markExplicitSignOut,
  resetDocumentIdentityForTests,
} from "@/lib/document-identity";

import { sessionIdentity, useReloadOnIdentityChange } from "./use-reload-on-identity-change";

const user = (id: string) => ({ status: "authenticated", session: { user: { id } } }) as const;

function useRenderWith(state: typeof boundary.state) {
  boundary.state = state;
  boundary.call = 0;
  boundary.refCall = 0;
  useReloadOnIdentityChange();
}

/** The `_app` shell unmounts (a public page): its effects clean up. */
function unmount() {
  for (const cleanup of boundary.cleanups) cleanup?.();
  boundary.deps = [];
  boundary.cleanups = [];
  boundary.refs = [];
}

/** window/document listeners by event type. */
const events = new Map<string, Set<() => void>>();
function listen(type: string, fn: () => void) {
  if (!events.has(type)) events.set(type, new Set());
  events.get(type)?.add(fn);
}
function fire(type: string) {
  for (const fn of events.get(type) ?? []) fn();
}
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

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
  boundary.checked = undefined;
  boundary.refetching = false;
  boundary.degraded = false;
  boundary.inFlight = false;
  FakeChannel.open = [];
  events.clear();
  vi.stubGlobal("window", {
    location: { reload: boundary.reload },
    addEventListener: (type: string, fn: () => void) => listen(type, fn),
    removeEventListener: (type: string, fn: () => void) => events.get(type)?.delete(fn),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    documentElement: { style: { setProperty: () => {} } },
    addEventListener: (type: string, fn: () => void) => listen(type, fn),
    removeEventListener: (type: string, fn: () => void) => events.get(type)?.delete(fn),
  });
  vi.stubGlobal("BroadcastChannel", FakeChannel);
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
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
    // Still on its way out when B is confirmed: one reload is enough.
    useRenderWith(user("b"));
    expect(boundary.reload).toHaveBeenCalledTimes(1);
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

  it("after a peer's announcement with no watcher mounted, re-checks on mount and stays neutral until then", async () => {
    // A on an `_app` page, then a public page: the shell unmounts.
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    // Another tab announces; nobody here can check it yet.
    channel?.onmessage?.({} as MessageEvent);
    expect(isDocumentIdentityUnverified()).toBe(true);
    // Back into the app (a guard error or an unguarded page: no guard
    // confirmed anyone). The mount check refetches; the atom says B.
    boundary.checked = "b";
    useRenderWith({ status: "pending" });
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("a fresh check that confirms the same account lifts the neutral chrome", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    boundary.checked = "a";
    useRenderWith({ status: "pending" });
    await Promise.resolve();
    await Promise.resolve();
    expect(isDocumentIdentityUnverified()).toBe(false);
    expect(boundary.reload).not.toHaveBeenCalled();
  });

  it("a failed check keeps it neutral; a guard's confirmation lifts it", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    boundary.checked = undefined;
    useRenderWith({ status: "pending" });
    await Promise.resolve();
    await Promise.resolve();
    expect(isDocumentIdentityUnverified()).toBe(true);
    await admitRouteIdentity({ status: "resolved", session: { user: { id: "a" } } });
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it("a failed mount check is retried on focus, visibility or reconnect, never left neutral", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    // Back in the shell: the mount check gets no fresh answer (offline, 503).
    boundary.checked = undefined;
    useRenderWith(user("a"));
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    // Back online: a new check of its own, still nothing.
    fire("online");
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(2);
    expect(isDocumentIdentityUnverified()).toBe(true);
    // The tab regains focus; this check's answer is A: the chrome comes back.
    boundary.checked = "a";
    fire("focus");
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(false);
    expect(boundary.reload).not.toHaveBeenCalled();
    // Settled: further focus events check nothing more.
    fire("visibilitychange");
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(3);
  });

  it("a retried check that answers another account replaces the document", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    useRenderWith(user("a"));
    await settle();
    boundary.checked = "b";
    fire("visibilitychange");
    await settle();
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it("a fetch in flight across an unmount and a newer invalidation can't settle it, even after a remount", async () => {
    const answers: (() => void)[] = [];
    boundary.refetch.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          answers.push(resolve);
        }),
    );
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    // Back in the shell: check 1 starts; the shell unmounts before it
    // answers; another tab announces a newer change.
    useRenderWith({ status: "pending" });
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    // The shell remounts while check 1 is still in flight: check 2 starts.
    useRenderWith({ status: "pending" });
    expect(answers).toHaveLength(2);
    // Check 1 answers A: it belongs to an unmounted watcher and predates the
    // newer change, so it settles nothing.
    boundary.checked = "a";
    answers[0]?.();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    // Check 2, asked after the change, answers A: now it is settled.
    answers[1]?.();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it("overlapping superseded checks leave no follow-up behind after unmount", async () => {
    vi.useFakeTimers();
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    // Every check is superseded by a fetch still running: each wants a follow-up.
    boundary.checked = undefined;
    boundary.inFlight = true;
    useRenderWith(user("a"));
    await settle();
    fire("focus");
    await settle();
    fire("online");
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(3);
    // The shell unmounts: no earlier follow-up may refetch afterwards.
    unmount();
    await vi.advanceTimersByTimeAsync(2000);
    expect(boundary.refetch).toHaveBeenCalledTimes(3);
  });

  it("a check superseded by an automatic refresh checks again once that settles", async () => {
    vi.useFakeTimers();
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({} as MessageEvent);
    // The mount check is cancelled by Better Auth's own cross-tab refresh,
    // which is still running when the check's promise resolves.
    boundary.checked = undefined;
    boundary.inFlight = true;
    useRenderWith(user("a"));
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    // That refresh settles with the same account; the follow-up check
    // (a new one of the watcher's own) confirms it with no other event.
    boundary.inFlight = false;
    boundary.checked = "a";
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(2);
    expect(isDocumentIdentityUnverified()).toBe(false);
  });
});
