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
  /** Override provenance when the atom retains a pre-announcement answer. */
  answerGeneration: undefined as number | undefined,
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
  readSessionIdentityGeneration: () =>
    boundary.answerGeneration ?? identityVerificationGeneration(),
  isSessionFetchInFlight: () => boundary.inFlight,
}));

import {
  admitRouteIdentity,
  identityVerificationGeneration,
  isDocumentIdentityUnverified,
  markExplicitSignOut,
  resetDocumentIdentityForTests,
} from "@/lib/document-identity";

import {
  connectSessionRetry,
  observeSessionRetry,
  recordSessionRetryAfter,
  resetSessionRetryForTests,
  trackNativeSessionCheck,
} from "@/lib/session-retry";

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
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

class FakeChannel {
  static open: FakeChannel[] = [];
  posted = 0;
  messages: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor() {
    FakeChannel.open.push(this);
  }
  postMessage(message: unknown) {
    this.posted++;
    this.messages.push(message);
  }
  close() {
    FakeChannel.open = FakeChannel.open.filter((c) => c !== this);
  }
}

beforeEach(() => {
  resetDocumentIdentityForTests();
  resetSessionRetryForTests();
  boundary.deps = [];
  boundary.cleanups = [];
  boundary.reload.mockReset();
  boundary.refetch.mockReset();
  boundary.checked = undefined;
  boundary.answerGeneration = undefined;
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
  it("presentation continuity alone never announces an identity", async () => {
    boundary.checked = undefined; // no successful settled atom answer
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    expect(channel?.messages).not.toContainEqual({ kind: "identity", id: "a" });
    boundary.checked = "a";
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    await settle();
    expect(channel?.messages.at(-1)).toEqual({ kind: "identity", id: "a" });
  });
  it("never broadcasts retained A on verify-email after a newer B announcement", async () => {
    useRenderWith({ status: "anonymous" });
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
    let finish!: () => void;
    boundary.refetch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    Object.assign(window.location, { pathname: "/en-US/verify-email" });
    // Presentation continuity still exposes old A before this mount's check.
    useRenderWith(user("a"));
    await settle();
    expect(channel?.messages).not.toContainEqual({ kind: "identity", id: "a" });
    expect(isDocumentIdentityUnverified()).toBe(true);
    boundary.checked = "b";
    finish();
    await settle();
    expect(channel?.messages.at(-1)).toEqual({ kind: "identity", id: "b" });
    expect(boundary.reload).not.toHaveBeenCalled();
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it("never adopts a focus probe superseded by a peer invalidation", async () => {
    vi.useFakeTimers();
    useRenderWith({ status: "anonymous" });
    const [channel] = FakeChannel.open;
    let finish!: () => void;
    let finishFresh!: () => void;
    boundary.refetch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    boundary.refetch.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFresh = resolve;
        }),
    );
    fire("focus");
    await settle();
    channel?.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
    boundary.checked = "a";
    finish();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    expect(channel?.messages).not.toContainEqual({ kind: "identity", id: "a" });
    boundary.checked = "b";
    finishFresh();
    await settle();
    expect(boundary.reload).not.toHaveBeenCalled();
    expect(isDocumentIdentityUnverified()).toBe(false);
    expect(channel?.messages.at(-1)).toEqual({ kind: "identity", id: "b" });
  });

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

  it("tells the other tabs about a sign-in, and checks the session on theirs", async () => {
    boundary.checked = null;
    useRenderWith({ status: "anonymous" });
    const [channel] = FakeChannel.open;
    expect(channel?.posted).toBe(1);
    boundary.checked = "a";
    useRenderWith(user("a"));
    expect(channel?.posted).toBe(2);
    useRenderWith(user("a"));
    expect(channel?.posted).toBe(2);
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    // The channel is the document's, not the shell's: it stays open.
    unmount();
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    expect(FakeChannel.open).toHaveLength(1);
  });

  it("after a peer's announcement with no watcher mounted, re-checks on mount and stays neutral until then", async () => {
    // A on an `_app` page, then a public page: the shell unmounts.
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    // Another tab announces; nobody here can check it yet.
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    expect(isDocumentIdentityUnverified()).toBe(true);
    // Back into the app (a guard error or an unguarded page: no guard
    // confirmed anyone). The mount check refetches; the atom says B.
    boundary.checked = "b";
    useRenderWith({ status: "pending" });
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    expect(boundary.reload).toHaveBeenCalledTimes(1);
  });

  it.each(["a", "b"])(
    "rejects a pre-announcement watcher answer and runs one fresh probe answering %s",
    async (freshIdentity) => {
      vi.useFakeTimers();
      const answers: (() => void)[] = [];
      boundary.refetch.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            answers.push(resolve);
          }),
      );
      useRenderWith(user("a"));
      const [channel] = FakeChannel.open;
      channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
      channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
      await settle();
      expect(boundary.refetch).toHaveBeenCalledTimes(1);
      channel?.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
      channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
      expect(boundary.reload).not.toHaveBeenCalled();
      // The check read A before the conflicting announcement arrived.
      boundary.checked = "a";
      answers[0]?.();
      await settle();
      useRenderWith(user("a"));
      expect(isDocumentIdentityUnverified()).toBe(true);
      expect(boundary.reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(249);
      expect(boundary.refetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(boundary.refetch).toHaveBeenCalledTimes(2);
      boundary.checked = freshIdentity;
      answers[1]?.();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(boundary.reload).toHaveBeenCalledTimes(freshIdentity === "b" ? 1 : 0);
      if (freshIdentity === "a") expect(isDocumentIdentityUnverified()).toBe(false);
      expect(boundary.refetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { checked: "b", reloads: 0 },
    { checked: "a", reloads: 1 },
    { checked: null, reloads: 1 },
    { checked: undefined, reloads: 0 },
  ])(
    "crossed confirmations: B receives stale A, server answers $checked, reloads $reloads times",
    async ({ checked, reloads }) => {
      vi.useFakeTimers();
      // B has confirmed locally; another tab's older A probe finishes before
      // that tab receives B's announcement and sends its crossed confirmation.
      await admitRouteIdentity({ status: "resolved", session: { user: { id: "b" } } });
      boundary.checked = "b";
      useRenderWith(user("b"));
      const [channel] = FakeChannel.open;
      let finish!: () => void;
      boundary.refetch.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      channel?.onmessage?.({ data: { kind: "identity", id: "a" } } as MessageEvent);
      await settle();
      channel?.onmessage?.({ data: { kind: "identity", id: "a" } } as MessageEvent);
      channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
      expect(boundary.reload).not.toHaveBeenCalled();
      expect(isDocumentIdentityUnverified()).toBe(true);
      expect(boundary.refetch).toHaveBeenCalledTimes(1);
      boundary.checked = checked;
      finish();
      await settle();
      expect(isDocumentIdentityUnverified()).toBe(true);
      expect(boundary.reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      expect(boundary.reload).toHaveBeenCalledTimes(reloads);
      expect(boundary.refetch).toHaveBeenCalledTimes(2);
      if (checked === "b") expect(isDocumentIdentityUnverified()).toBe(false);
      if (checked === undefined) expect(isDocumentIdentityUnverified()).toBe(true);
      expect(channel?.messages).not.toContainEqual({ kind: "identity", id: "a" });
    },
  );

  it("a fresh check that confirms the same account lifts the neutral chrome", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    boundary.checked = "a";
    useRenderWith({ status: "pending" });
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(false);
    expect(boundary.reload).not.toHaveBeenCalled();
  });

  it("a failed check keeps it neutral; a guard's confirmation lifts it", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    boundary.checked = undefined;
    useRenderWith({ status: "pending" });
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    await admitRouteIdentity({ status: "resolved", session: { user: { id: "a" } } });
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it("a failed mount check is retried on focus, visibility or reconnect, never left neutral", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
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
    // Healthy sessions also revalidate here: Better Auth's duplicate focus
    // refresh is disabled so every event shares the cooldown coordinator.
    fire("visibilitychange");
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(4);
  });

  it.each(["focus", "visibilitychange", "online", "identity"])(
    "%s during Retry-After cannot bypass cooldown with the watcher mounted",
    async (event) => {
      vi.useFakeTimers();
      // The real useAuthSession adapter connects the same refetch to the
      // coordinator. Keep that connection while this watcher is mounted.
      const disconnect = connectSessionRetry(boundary.refetch);
      boundary.refetch.mockImplementationOnce(() => {
        recordSessionRetryAfter(
          new Response(null, { status: 429, headers: { "Retry-After": "10" } }),
        );
        observeSessionRetry({ status: 429 }, false);
      });
      useRenderWith(user("a"));
      try {
        const [channel] = FakeChannel.open;
        channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
        await settle();
        expect(boundary.refetch).toHaveBeenCalledTimes(1);
        expect(isDocumentIdentityUnverified()).toBe(true);
        if (event === "identity") {
          channel?.onmessage?.({ data: { kind: "identity", id: "b" } } as MessageEvent);
        } else fire(event);
        await settle();
        expect(boundary.reload).not.toHaveBeenCalled();
        expect(boundary.refetch).toHaveBeenCalledTimes(1);
        expect(isDocumentIdentityUnverified()).toBe(true);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(boundary.refetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(boundary.refetch).toHaveBeenCalledTimes(2);
      } finally {
        disconnect();
      }
    },
  );

  it("a retried check that answers another account replaces the document", async () => {
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
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
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    // Back in the shell: check 1 starts; the shell unmounts before it
    // answers; another tab announces a newer change.
    useRenderWith({ status: "pending" });
    await settle();
    unmount();
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    // The shell remounts while check 1 runs: a fresh check waits its turn.
    useRenderWith({ status: "pending" });
    await settle();
    expect(answers).toHaveLength(1);
    // Check 1 answers A: it belongs to an unmounted watcher and predates the
    // newer change, so it settles nothing.
    boundary.checked = "a";
    answers[0]?.();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(true);
    expect(answers).toHaveLength(2);
    // Check 2, asked after the change, answers A: now it is settled.
    answers[1]?.();
    await settle();
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it.each(["b", "a", null])(
    "retries a disconnected producer's skipped probe before accepting fresh %s",
    async (freshIdentity) => {
      vi.useFakeTimers();
      boundary.checked = null;
      useRenderWith({ status: "anonymous" });
      const [channel] = FakeChannel.open;
      const finishNative = trackNativeSessionCheck();
      const nativeGeneration = identityVerificationGeneration();
      // The old watcher queues a fresh probe behind a native request that
      // started before this announcement, then disconnects before it runs.
      channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
      await settle();
      unmount();
      await admitRouteIdentity({ status: "resolved", session: { user: { id: "b" } } });
      // A guard confirmed B without updating Better Auth's atom. The new
      // watcher joins the same native wait, with obsolete A still retained.
      boundary.checked = "a";
      boundary.answerGeneration = nativeGeneration;
      useRenderWith(user("a"));
      expect(boundary.refetch).not.toHaveBeenCalled();
      finishNative();
      await settle();
      expect(boundary.reload).not.toHaveBeenCalled();
      expect(channel?.messages).not.toContainEqual({ kind: "identity", id: "a" });
      expect(boundary.refetch).not.toHaveBeenCalled();

      let finishFresh!: () => void;
      boundary.refetch.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFresh = resolve;
          }),
      );
      await vi.advanceTimersByTimeAsync(249);
      expect(boundary.refetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(boundary.refetch).toHaveBeenCalledTimes(1);
      // Focus/network events during that retry share the one actual probe.
      fire("focus");
      fire("online");
      fire("visibilitychange");
      await settle();
      expect(boundary.refetch).toHaveBeenCalledTimes(1);
      expect(boundary.reload).not.toHaveBeenCalled();
      boundary.checked = freshIdentity;
      boundary.answerGeneration = identityVerificationGeneration();
      finishFresh();
      await settle();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(boundary.reload).toHaveBeenCalledTimes(freshIdentity === "b" ? 0 : 1);
      expect(isDocumentIdentityUnverified()).toBe(false);
      expect(boundary.refetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "focus takes over a pending provenance retry (response held past deadline: %s)",
    async (held) => {
      vi.useFakeTimers();
      useRenderWith(user("a"));
      const [channel] = FakeChannel.open;
      // The atom still carries an answer from before the peer invalidation.
      boundary.checked = "a";
      boundary.answerGeneration = identityVerificationGeneration();
      channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
      await settle();
      expect(boundary.refetch).toHaveBeenCalledTimes(1);
      expect(isDocumentIdentityUnverified()).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      expect(channel?.messages).not.toContainEqual({ kind: "identity", id: "a" });

      await vi.advanceTimersByTimeAsync(100);
      let finish!: () => void;
      if (held) {
        boundary.refetch.mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        );
      } else {
        boundary.answerGeneration = identityVerificationGeneration();
      }
      fire("focus");
      await settle();
      expect(boundary.refetch).toHaveBeenCalledTimes(2);
      // A request that actually started owns verification even before it
      // settles; the older timer must not join it at the old deadline.
      if (held) expect(vi.getTimerCount()).toBe(0);
      else expect(isDocumentIdentityUnverified()).toBe(false);
      await vi.advanceTimersByTimeAsync(150);
      expect(boundary.refetch).toHaveBeenCalledTimes(2);
      if (held) {
        expect(isDocumentIdentityUnverified()).toBe(true);
        expect(channel?.messages).not.toContainEqual({ kind: "identity", id: "a" });
        boundary.answerGeneration = identityVerificationGeneration();
        finish();
        await settle();
      }
      expect(isDocumentIdentityUnverified()).toBe(false);
      expect(channel?.messages.at(-1)).toEqual({ kind: "identity", id: "a" });
      expect(boundary.reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(boundary.refetch).toHaveBeenCalledTimes(2);
    },
  );

  it("unmount cancels the sole pending provenance retry", async () => {
    vi.useFakeTimers();
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    boundary.checked = "a";
    boundary.answerGeneration = identityVerificationGeneration();
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
    await settle();
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    boundary.answerGeneration = identityVerificationGeneration();
    await vi.advanceTimersByTimeAsync(1_000);
    fire("focus");
    expect(boundary.refetch).toHaveBeenCalledTimes(1);
    expect(isDocumentIdentityUnverified()).toBe(true);
    expect(boundary.reload).not.toHaveBeenCalled();
  });

  it("a check superseded by an automatic refresh checks again once that settles", async () => {
    vi.useFakeTimers();
    useRenderWith(user("a"));
    const [channel] = FakeChannel.open;
    unmount();
    channel?.onmessage?.({ data: { kind: "session-changed" } } as MessageEvent);
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
