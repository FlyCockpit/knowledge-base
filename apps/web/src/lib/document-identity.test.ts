import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  admitRouteIdentity,
  announceDocumentIdentity,
  announceSessionChange,
  confirmDocumentIdentityFresh,
  connectIdentityPeers,
  identityVerificationGeneration,
  isDocumentIdentityUnverified,
  isDocumentReplaced,
  leaveDocument,
  markExplicitSignOut,
  observeDocumentIdentity,
  onDocumentReplaced,
  replaceDocument,
  reportSessionRejected,
  resetDocumentIdentityForTests,
  sealQueryClient,
  shouldReloadForIdentity,
  skipErrorToastForIdentity,
  subscribeIdentityVerification,
  watchDocumentRestore,
} from "./document-identity";

const reload = vi.fn();
let pageshow: ((event: { persisted: boolean }) => void) | undefined;
let pagehide: ((event: { persisted: boolean }) => void) | undefined;
const assign = vi.fn();
/** The root element's inline style, as `hidePage` writes it. */
const root = {
  style: {
    display: "",
    priority: "",
    setProperty(name: string, value: string, priority: string) {
      if (name === "display") Object.assign(this, { display: value, priority });
    },
  },
};
const hidden = () => root.style.display === "none" && root.style.priority === "important";

beforeEach(() => {
  resetDocumentIdentityForTests(() => undefined);
  reload.mockReset();
  assign.mockReset();
  Object.assign(root.style, { display: "", priority: "" });
  pageshow = undefined;
  pagehide = undefined;
  vi.stubGlobal("window", {
    location: { reload, assign },
    addEventListener: (type: string, listener: (event: { persisted: boolean }) => void) => {
      if (type === "pageshow") pageshow = listener;
      if (type === "pagehide") pagehide = listener;
    },
  });
  vi.stubGlobal("document", { documentElement: root, title: "Private KB · Knowledge Base" });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const resolved = (id: string | null) =>
  ({ status: "resolved", session: id === null ? null : { user: { id } } }) as const;

/** Whether a promise settled within a few macrotasks. */
async function settles(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  return settled;
}

const unauthorized = () =>
  Object.assign(new Error("no session"), { code: "UNAUTHORIZED", status: 401 });

describe("shouldReloadForIdentity", () => {
  it("only reloads when a signed-in user goes away", () => {
    expect(shouldReloadForIdentity(undefined, "u1")).toBe(false);
    expect(shouldReloadForIdentity("u1", undefined)).toBe(false);
    expect(shouldReloadForIdentity("u1", "u1")).toBe(false);
    expect(shouldReloadForIdentity(null, null)).toBe(false);
    // Anonymous → signed in carries only public data; no reload.
    expect(shouldReloadForIdentity(null, "u1")).toBe(false);
    expect(shouldReloadForIdentity("u1", null)).toBe(true);
    expect(shouldReloadForIdentity("u1", "u2")).toBe(true);
  });
});

describe("observeDocumentIdentity", () => {
  it("A → sign-out → B replaces the document at the sign-out, and stays replaced", () => {
    expect(observeDocumentIdentity("a")).toBe(false);
    expect(observeDocumentIdentity("a")).toBe(false);
    expect(observeDocumentIdentity(null)).toBe(true);
    expect(isDocumentReplaced()).toBe(true);
    // The account that signs in next still finds a document on its way out.
    expect(observeDocumentIdentity("b")).toBe(true);
  });

  it("A → B directly replaces the document", () => {
    expect(observeDocumentIdentity("a")).toBe(false);
    expect(observeDocumentIdentity("b")).toBe(true);
  });

  it("signing in on an anonymous document keeps it, then guards the new account", () => {
    expect(observeDocumentIdentity(null)).toBe(false);
    expect(observeDocumentIdentity("a")).toBe(false);
    expect(observeDocumentIdentity("b")).toBe(true);
  });

  it("is never written during SSR (module state is process-wide there)", () => {
    vi.unstubAllGlobals();
    expect(observeDocumentIdentity("a")).toBe(false);
    expect(observeDocumentIdentity("b")).toBe(false);
  });
});

describe("admitRouteIdentity (session guards)", () => {
  it("admits the document's own identity and a failed probe", async () => {
    expect(await settles(admitRouteIdentity(resolved("a")))).toBe(true);
    expect(await settles(admitRouteIdentity({ status: "error" }))).toBe(true);
    expect(await settles(admitRouteIdentity(resolved("a")))).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("catches a switch made while no `_app` page (and so no watcher) was open", async () => {
    // An `_app` page as A, then a public page: the shell (and its watcher)
    // unmounts. Another account signs in meanwhile. Back into the app, the
    // guard sees B before anything renders: the document reloads and the
    // guard never settles, so no page under it shows A's cache.
    expect(await settles(admitRouteIdentity(resolved("a")))).toBe(true);
    expect(await settles(admitRouteIdentity(resolved("b")))).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("catches a sign-out elsewhere on the next anonymous-only page (login)", async () => {
    await admitRouteIdentity(resolved("a"));
    expect(await settles(admitRouteIdentity(resolved(null)))).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("explicit sign-out", () => {
  it("a failed sign-out after the identity changed anyway replaces the document", () => {
    observeDocumentIdentity("a");
    const undo = markExplicitSignOut();
    // Another tab's sign-out lands first; this tab's own request then fails.
    expect(observeDocumentIdentity(null)).toBe(true);
    replaceDocument();
    expect(reload).not.toHaveBeenCalled();
    undo();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a successful sign-out quarantines the document before loading the sign-in page", () => {
    const seal = vi.fn();
    onDocumentReplaced(seal);
    observeDocumentIdentity("a");
    markExplicitSignOut();
    // The signed-out session is seen first: hidden and sealed, no reload.
    expect(observeDocumentIdentity(null)).toBe(true);
    replaceDocument();
    expect(hidden()).toBe(true);
    expect(seal).toHaveBeenCalledTimes(1);
    expect(reload).not.toHaveBeenCalled();
    leaveDocument("/en-US/login");
    expect(assign).toHaveBeenCalledWith("/en-US/login");
    expect(seal).toHaveBeenCalledTimes(1);
  });

  it("leaveDocument quarantines even before the session change is seen", () => {
    const seal = vi.fn();
    onDocumentReplaced(seal);
    observeDocumentIdentity("a");
    markExplicitSignOut();
    leaveDocument("/en-US/login");
    expect(hidden()).toBe(true);
    // The tab title (a private KB's name) goes with the page.
    expect(document.title).toBe("");
    expect(seal).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("hides a signed-in page as it enters the back/forward cache, and reloads it on restore", () => {
    const seal = vi.fn();
    onDocumentReplaced(seal);
    watchDocumentRestore();
    observeDocumentIdentity("a");
    // A normal unload (not cached) leaves the page alone.
    pagehide?.({ persisted: false });
    expect(hidden()).toBe(false);
    pagehide?.({ persisted: true });
    expect(hidden()).toBe(true);
    // Another account signs in meanwhile; Back restores this frozen copy.
    pageshow?.({ persisted: true });
    expect(seal).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("restores an anonymous page from the back/forward cache as it is", () => {
    watchDocumentRestore();
    observeDocumentIdentity(null);
    pagehide?.({ persisted: true });
    pageshow?.({ persisted: true });
    expect(hidden()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads any restored copy that held a signed-in user's state", () => {
    watchDocumentRestore();
    pageshow?.({ persisted: true });
    expect(reload).not.toHaveBeenCalled();
    observeDocumentIdentity(null);
    pageshow?.({ persisted: true });
    expect(reload).not.toHaveBeenCalled();
    // Signed in, then frozen in the back/forward cache with no identity
    // change seen: the session may have expired or been revoked meanwhile.
    observeDocumentIdentity("a");
    pageshow?.({ persisted: false });
    expect(reload).not.toHaveBeenCalled();
    pageshow?.({ persisted: true });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads a restored copy after a sign-out or an identity change", () => {
    watchDocumentRestore();
    observeDocumentIdentity("a");
    markExplicitSignOut();
    observeDocumentIdentity("b");
    pageshow?.({ persisted: true });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("global error toasts", () => {
  function appClient(toast: (kind: string) => void) {
    return new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      queryCache: new QueryCache({
        onError: (error) => {
          if (skipErrorToastForIdentity(error, "query")) return;
          toast("query");
        },
      }),
      mutationCache: new MutationCache({
        onError: (error) => {
          if (skipErrorToastForIdentity(error, "mutation")) return;
          toast("mutation");
        },
      }),
    });
  }

  it("401s arriving apart while a session check runs share it", async () => {
    let finish!: () => void;
    const check = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    connectIdentityPeers(check);
    reportSessionRejected();
    await new Promise((r) => setTimeout(r, 0));
    reportSessionRejected();
    await new Promise((r) => setTimeout(r, 0));
    reportSessionRejected();
    expect(check).toHaveBeenCalledTimes(1);
    finish();
    await new Promise((r) => setTimeout(r, 0));
    reportSessionRejected();
    await new Promise((r) => setTimeout(r, 0));
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("a session lost elsewhere: no 401 toast storm, one session check", async () => {
    const toast = vi.fn();
    const check = vi.fn();
    connectIdentityPeers(check);
    const client = appClient(toast);
    await Promise.allSettled(
      ["kbs", "documents", "members", "tokens", "settings"].map((key) =>
        client.fetchQuery({ queryKey: [key], queryFn: () => Promise.reject(unauthorized()) }),
      ),
    );
    await Promise.resolve();
    expect(toast).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("still toasts a failed action, and any other query error", async () => {
    const toast = vi.fn();
    connectIdentityPeers(vi.fn());
    const client = appClient(toast);
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(unauthorized()) })
      .execute(undefined)
      .catch(() => {});
    await client
      .fetchQuery({ queryKey: ["x"], queryFn: () => Promise.reject(new Error("boom")) })
      .catch(() => {});
    expect(toast.mock.calls).toEqual([["mutation"], ["query"]]);
  });

  it("a mutation whose response arrives after the switch cannot write A's data back", async () => {
    const toast = vi.fn();
    const client = appClient(toast);
    onDocumentReplaced(() => sealQueryClient(client));
    observeDocumentIdentity("a");
    client.setQueryData(["documents"], ["A's private document"]);
    let respond!: (value: { name: string }) => void;
    let fail!: (error: Error) => void;
    const save = client.getMutationCache().build(client, {
      mutationFn: () =>
        new Promise<{ name: string }>((resolve) => {
          respond = resolve;
        }),
      onSuccess: (data: { name: string }) => client.setQueryData(["settings"], data),
    });
    const late = save.execute(undefined);
    const exported = client
      .getMutationCache()
      .build(client, {
        mutationFn: () =>
          new Promise((_, reject) => {
            fail = reject;
          }),
      })
      .execute(undefined)
      .catch(() => {});

    // mutationFn starts after a microtask.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    // Account B is confirmed while both requests are in flight. Before the
    // (asynchronous) reload starts, the page is hidden and the cache emptied;
    // A's late write is dropped as soon as it lands, and a late failure
    // doesn't toast.
    expect(observeDocumentIdentity("b")).toBe(true);
    replaceDocument();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(hidden()).toBe(true);
    expect(client.getQueryData(["documents"])).toBeUndefined();
    respond({ name: "A's settings" });
    fail(new Error("late"));
    await late;
    await exported;
    await new Promise((r) => setTimeout(r, 0));
    expect(client.getQueryData(["settings"])).toBeUndefined();
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(isDocumentReplaced()).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("other tabs", () => {
  function fakeChannel() {
    return {
      postMessage: vi.fn(),
      onmessage: null as ((event: MessageEvent) => void) | null,
    };
  }

  it("announces each newly confirmed identity once, and checks the session on a peer's", () => {
    const channel = fakeChannel();
    resetDocumentIdentityForTests(() => channel);
    const check = vi.fn();
    const disconnect = connectIdentityPeers(check);
    announceDocumentIdentity(null);
    announceDocumentIdentity("a");
    announceDocumentIdentity("a");
    expect(channel.postMessage).toHaveBeenCalledTimes(2);
    channel.onmessage?.({} as MessageEvent);
    expect(check).toHaveBeenCalledTimes(1);
    // Without a watcher, a peer's announcement or a 401 checks nothing.
    disconnect();
    channel.onmessage?.({} as MessageEvent);
    reportSessionRejected();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("an identity announced across a remount of the watcher is not announced twice", () => {
    const channel = fakeChannel();
    resetDocumentIdentityForTests(() => channel);
    connectIdentityPeers(vi.fn())();
    announceDocumentIdentity("a");
    connectIdentityPeers(vi.fn());
    announceDocumentIdentity("a");
    expect(channel.postMessage).toHaveBeenCalledTimes(1);
  });

  it("a session change made here is announced before the flow navigates", () => {
    const channel = fakeChannel();
    resetDocumentIdentityForTests(() => channel);
    // Every time: a sign-in, then a 2FA verification, each is news to peers.
    announceSessionChange();
    announceSessionChange();
    expect(channel.postMessage).toHaveBeenCalledTimes(2);
  });

  it("a peer's announcement or a 401 with no watcher mounted leaves the identity unverified", async () => {
    const channel = fakeChannel();
    resetDocumentIdentityForTests(() => channel);
    const changed = vi.fn();
    subscribeIdentityVerification(changed);
    observeDocumentIdentity("a");
    announceDocumentIdentity("a");
    channel.onmessage?.({} as MessageEvent);
    expect(isDocumentIdentityUnverified()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    // A guard's server answer for the same account confirms it.
    await admitRouteIdentity(resolved("a"));
    expect(isDocumentIdentityUnverified()).toBe(false);
    reportSessionRejected();
    expect(isDocumentIdentityUnverified()).toBe(true);
  });

  it("an answer that predates a newer invalidation settles nothing", async () => {
    const channel = fakeChannel();
    resetDocumentIdentityForTests(() => channel);
    observeDocumentIdentity("a");
    announceDocumentIdentity("a");
    channel.onmessage?.({} as MessageEvent);
    // A guard's probe starts, then another tab announces again mid-probe.
    const since = identityVerificationGeneration();
    channel.onmessage?.({} as MessageEvent);
    await admitRouteIdentity(resolved("a"), since);
    expect(isDocumentIdentityUnverified()).toBe(true);
    confirmDocumentIdentityFresh(since);
    expect(isDocumentIdentityUnverified()).toBe(true);
    confirmDocumentIdentityFresh(identityVerificationGeneration());
    expect(isDocumentIdentityUnverified()).toBe(false);
  });

  it("a guard announces a sign-in whose page never mounts the `_app` shell", async () => {
    // Window 2 signs in as B and lands on a hidden admin page: the guard
    // confirms B and renders a public 404, so no watcher ever runs there.
    const channel = fakeChannel();
    resetDocumentIdentityForTests(() => channel);
    expect(await settles(admitRouteIdentity(resolved("b")))).toBe(true);
    expect(channel.postMessage).toHaveBeenCalledTimes(1);
    // A replaced document announces nothing: it is on its way out.
    expect(await settles(admitRouteIdentity(resolved("c")))).toBe(false);
    expect(channel.postMessage).toHaveBeenCalledTimes(1);
  });
});
