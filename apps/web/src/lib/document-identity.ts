/**
 * Who this document's in-memory private state belongs to: the TanStack Query
 * cache, Zustand stores, module state and every in-flight request callback.
 * It is one identity for the whole life of the document, kept here at module
 * scope rather than in a component, so no layout unmount (a public page, a 404,
 * an error-state reset) can make it forget whose data is in memory.
 *
 * When a confirmed identity differs from it (sign-out in another tab, session
 * expiry or revocation, another account signing in), the document is replaced
 * with a full load: the one reset that drops all of that state at once, and
 * leaves no late mutation callback a cache to write into. Two places observe
 * the identity: every session route guard (`resolveRouteSession`), before
 * anything under it renders, and the watcher mounted by the `_app` shell and the
 * standalone device/consent pages
 * (`useReloadOnIdentityChange`), for a change while a page is open.
 * docs/ui.md § Query cache follows identity.
 *
 * No runtime imports, so the router and the route guards use it without
 * loading Better Auth.
 */
import type { QueryClient } from "@tanstack/react-query";

/** A user id when signed in, `null` when confirmed anonymous, `undefined` while not known. */
export type SessionIdentity = string | null | undefined;

const documentIdentity = {
  /** The identity this document's private state belongs to. */
  baseline: undefined as SessionIdentity,
  /** A different identity was confirmed: this document is being replaced. */
  replaced: false,
  /** An explicit sign-out's own page load is under way. */
  leaving: false,
  /** A signed-in user's private state was in memory at some point. */
  heldPrivateState: false,
  /** The private UI was hidden and the cache dropped, ahead of the reload. */
  quarantined: false,
  /** The replacing reload was requested (once is enough). */
  reloading: false,
};

const replaceListeners = new Set<() => void>();

/**
 * True when a signed-in user's in-memory state must be dropped: the last known
 * identity was a user and the next known identity is a different user or
 * anonymous. Anonymous → signed in is not a leak (an anonymous cache only holds
 * public data), and `undefined` (pending, or a failed check) is never acted on,
 * so a flaky session check never reloads a signed-in user's page.
 */
export function shouldReloadForIdentity(
  lastKnown: SessionIdentity,
  next: SessionIdentity,
): boolean {
  return typeof lastKnown === "string" && next !== undefined && next !== lastKnown;
}

/**
 * Record a confirmed identity: a route guard's server answer or the watcher's
 * session. Returns true when this document's private state belongs to someone
 * else and the document must be replaced; once true, it stays true for the
 * rest of the document.
 */
export function observeDocumentIdentity(next: string | null): boolean {
  // Module state is process-wide on the server: never written there.
  if (typeof window === "undefined") return false;
  if (documentIdentity.replaced) return true;
  if (shouldReloadForIdentity(documentIdentity.baseline, next)) {
    documentIdentity.replaced = true;
    return true;
  }
  documentIdentity.baseline = next;
  if (typeof next === "string") documentIdentity.heldPrivateState = true;
  return false;
}

/** A different identity was confirmed and this document is on its way out. */
export function isDocumentReplaced(): boolean {
  return documentIdentity.replaced;
}

/**
 * The previous identity's state was taken out of reach and the page load that
 * replaces this document is under way. A `beforeunload` handler must not
 * cancel that load: "Stay" would leave a hidden page with a sealed cache.
 */
export function isDocumentQuarantined(): boolean {
  return documentIdentity.quarantined;
}

/**
 * Run when the document is replaced, before the reload starts: the router
 * drops its QueryClient's data here. Returns the unsubscribe.
 */
export function onDocumentReplaced(listener: () => void): () => void {
  replaceListeners.add(listener);
  return () => replaceListeners.delete(listener);
}

/**
 * Drop a replaced document's query data and keep it empty until the reload
 * commits: every query and mutation is removed, and any query a late callback
 * (an A-era mutation's `onSuccess` → `setQueryData`) or a still-mounted
 * observer creates afterwards is removed again as soon as it is added.
 */
export function sealQueryClient(queryClient: QueryClient): void {
  const queries = queryClient.getQueryCache();
  queryClient.getMutationCache().clear();
  queries.clear();
  queries.subscribe((event) => {
    if (event.type === "added") queries.remove(event.query);
  });
}

function hidePage(): void {
  // `display: none` on the root, important: no descendant can opt back in
  // (`visibility: hidden` can be undone by any element that sets itself
  // `visible`). CSSOM, not a style attribute: allowed under the strict
  // style-src CSP.
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty("display", "none", "important");
  blankTitle();
}

let titleBlanked = false;

/**
 * The tab title outlives a hidden page (route titles name private KBs): blank
 * it, and keep it blank against a late head update until the page goes.
 */
function blankTitle(): void {
  document.title = "";
  if (titleBlanked || typeof MutationObserver === "undefined" || !document.head) return;
  titleBlanked = true;
  new MutationObserver(() => {
    if (document.title !== "") document.title = "";
  }).observe(document.head, { subtree: true, childList: true, characterData: true });
}

/**
 * Take the previous identity's state out of reach synchronously, ahead of an
 * asynchronous page load (the old page stays up until the new one commits,
 * which can take a while on a slow connection): the page is hidden and the
 * query cache sealed (`onDocumentReplaced`), so nothing of it stays on screen
 * and a late callback can only write into a hidden, discarded document.
 */
function quarantineDocument(): void {
  if (documentIdentity.quarantined) return;
  documentIdentity.quarantined = true;
  hidePage();
  for (const listener of replaceListeners) listener();
}

/**
 * Replace the document with a fresh load of the same URL, where the route
 * guards send the new identity wherever it belongs. Quarantined first. An
 * explicit sign-out already owns the document's navigation (`leaveDocument`
 * to the sign-in page), so it is left to finish; `markExplicitSignOut`'s undo
 * reloads here instead if that sign-out fails.
 */
export function replaceDocument(): void {
  if (typeof window === "undefined") return;
  quarantineDocument();
  if (documentIdentity.leaving || documentIdentity.reloading) return;
  documentIdentity.reloading = true;
  // An identity change discards all prior user cache and mounted client state.
  window.location.reload();
}

/**
 * An explicit sign-out's page load, once the sign-out succeeded: quarantine
 * the document, then load `href` (the sign-in page) as a new document with an
 * empty cache.
 */
export function leaveDocument(href: string): void {
  if (typeof window === "undefined") return;
  quarantineDocument();
  // Sign-out discards the previous identity's cache and client state.
  window.location.assign(href);
}

type RouteIdentityResolution =
  | { status: "resolved"; session: { user: { id: string } } | null }
  | { status: "error" };

/**
 * A session guard's check, after its server probe and before anything under
 * it loads or renders. A different identity than this document's replaces the
 * document, and the guard never settles, so no page renders the previous
 * identity's cached data even for a frame. A failed probe decides nothing.
 */
export async function admitRouteIdentity(
  resolution: RouteIdentityResolution,
  /** `identityVerificationGeneration()` taken before the probe started. */
  since: number = verificationGeneration,
): Promise<void> {
  if (resolution.status !== "resolved") return;
  const identity = resolution.session?.user.id ?? null;
  if (!observeDocumentIdentity(identity)) {
    // The server just confirmed this document's own identity.
    confirmDocumentIdentityFresh(since);
    announceDocumentIdentity(identity);
    return;
  }
  replaceDocument();
  await new Promise<never>(() => {});
}

/**
 * Call right before an explicit sign-out that ends in `leaveDocument`,
 * so the watcher doesn't race it with a reload of the signed-out page (an
 * extra load, and a `redirectTo` back to the old user's page). Returns the
 * undo for a sign-out that failed (still signed in here). If the identity
 * changed meanwhile anyway (another tab signed out first), the undo replaces
 * the document at once: nothing else would.
 */
export function markExplicitSignOut(): () => void {
  documentIdentity.leaving = true;
  return () => {
    documentIdentity.leaving = false;
    if (documentIdentity.replaced) replaceDocument();
  };
}

let restoreWatched = false;

/**
 * Installed once per document by the router. A page restored from the
 * back/forward cache is the old document, private state included, frozen
 * without any check since (Back after signing out, after another account
 * signed in, or after the session expired or was revoked meanwhile, would show
 * the previous account's page). So a document that ever held a signed-in
 * user's state is hidden as it enters the cache (the restored frame is blank,
 * never the old page), and on restore it is quarantined and reloaded for the
 * route guards to decide again. An anonymous one is cached and restored as it
 * is.
 */
export function watchDocumentRestore(): void {
  if (typeof window === "undefined" || restoreWatched) return;
  restoreWatched = true;
  const holdsPrivateState = () => documentIdentity.heldPrivateState || documentIdentity.replaced;
  window.addEventListener("pagehide", (event) => {
    if (event.persisted && holdsPrivateState()) hidePage();
  });
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted || !holdsPrivateState()) return;
    documentIdentity.leaving = false;
    quarantineDocument();
    // A restored copy may hold a previous identity's private state.
    window.location.reload();
  });
}

/** An API answer that says this request had no valid session (oRPC or Better Auth). */
/** A request refused for having no session (401 / UNAUTHORIZED). */
export function isSessionRejection(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; status?: unknown };
  return e.code === "UNAUTHORIZED" || e.status === 401;
}

/**
 * The global error toasts' identity filter. A query rejected for having no
 * session queues one session check instead of a toast (so a session lost
 * elsewhere ends in a document replacement, not one toast per mounted query);
 * a mutation still toasts, since an action must never fail silently. Nothing
 * toasts once the document is being replaced. True: skip the toast.
 */
export function skipErrorToastForIdentity(error: unknown, kind: "query" | "mutation"): boolean {
  if (documentIdentity.replaced) return true;
  if (!isSessionRejection(error)) return false;
  reportSessionRejected();
  return kind === "query";
}

/**
 * Another tab announced an identity change (or a request was refused for
 * having no session) while no watcher could check it: Better Auth's atom may
 * still hold the previous account. Until a fresh check (a guard's server
 * probe, or the watcher's refetch when it mounts) confirms this document's
 * identity, `useAuthSession()` reports `pending`, so no chrome shows that
 * stale account, even on a page a guard didn't admit (a guard error, an
 * unguarded page).
 */
let identityUnverified = false;
/** Bumped by every invalidation, so an answer that predates one can't settle it. */
let verificationGeneration = 0;
const verificationListeners = new Set<() => void>();

function setIdentityUnverified(next: boolean): void {
  // Module state is process-wide on the server: never written there.
  if (typeof window === "undefined" || identityUnverified === next) return;
  identityUnverified = next;
  for (const listener of verificationListeners) listener();
}

function markIdentityUnverified(): void {
  if (typeof window === "undefined") return;
  verificationGeneration++;
  setIdentityUnverified(true);
}

/** Taken before a check starts; pass it to `confirmDocumentIdentityFresh`. */
export function identityVerificationGeneration(): number {
  return verificationGeneration;
}

/**
 * A fresh check confirmed this document's identity: the chrome may show it
 * again, unless the identity was invalidated again after that check started
 * (`since`, from `identityVerificationGeneration()`): its answer may predate
 * the newer change.
 */
export function confirmDocumentIdentityFresh(since: number): void {
  if (since !== verificationGeneration) return;
  setIdentityUnverified(false);
}

export function isDocumentIdentityUnverified(): boolean {
  return identityUnverified;
}

export function subscribeIdentityVerification(listener: () => void): () => void {
  verificationListeners.add(listener);
  return () => verificationListeners.delete(listener);
}

let sessionCheck: (() => unknown) | undefined;
let sessionCheckPending = false;

/**
 * A request was rejected for having no session: ask Better Auth to check the
 * session once (however many queries failed together), so a session lost
 * elsewhere replaces the document instead of leaving one error toast per
 * query. With no watcher mounted, the identity is left unverified until one
 * (or a guard) checks it.
 */
export function reportSessionRejected(): void {
  const check = sessionCheck;
  if (!check) {
    markIdentityUnverified();
    return;
  }
  if (sessionCheckPending) return;
  // One check at a time, until it settles: 401s that arrive in separate
  // network tasks while it runs share it.
  sessionCheckPending = true;
  void Promise.resolve()
    .then(check)
    .catch(() => {})
    .finally(() => {
      sessionCheckPending = false;
    });
}

/** The channel the open tabs use to tell each other the signed-in identity changed. */
const IDENTITY_CHANNEL = "app-session-identity";

type IdentityChannel = Pick<BroadcastChannel, "postMessage"> & {
  onmessage: ((event: MessageEvent) => void) | null;
};

const openBroadcastChannel = (): IdentityChannel | undefined =>
  typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel(IDENTITY_CHANNEL);

let openChannel = openBroadcastChannel;
let peers: IdentityChannel | undefined;
let peersOpened = false;
let announced: SessionIdentity;

/**
 * The document's one channel to the other open tabs, opened on first use and
 * kept for the document's life, so an announcement never depends on which
 * layout is mounted. Better Auth tells the other tabs about a sign-out, but not
 * about a sign-in: a tab where an identity is confirmed announces it here, and
 * every other tab with a watcher checks its session (and replaces its document
 * if the account is not its own).
 */
function peerChannel(): IdentityChannel | undefined {
  if (typeof window === "undefined") return undefined;
  if (!peersOpened) {
    peersOpened = true;
    peers = openChannel();
    if (peers) {
      peers.onmessage = () => {
        if (sessionCheck) void sessionCheck();
        else markIdentityUnverified();
      };
    }
  }
  return peers;
}

/**
 * Connect the watcher's session check: run for a peer tab's
 * announcement and for a 401 (`reportSessionRejected`). Returns the
 * disconnect.
 */
export function connectIdentityPeers(checkSession: () => unknown): () => void {
  sessionCheck = checkSession;
  peerChannel();
  return () => {
    if (sessionCheck === checkSession) sessionCheck = undefined;
  };
}

/**
 * Tell the other tabs about a confirmed identity this document has not
 * announced yet. Called by the watcher and by every session guard
 * (`admitRouteIdentity`), so a sign-in whose destination page never mounts the
 * `_app` shell (a hidden admin 404) is still announced.
 */
export function announceDocumentIdentity(identity: string | null): void {
  if (identity === announced) return;
  const channel = peerChannel();
  if (!channel) return;
  announced = identity;
  channel.postMessage("identity-changed");
}

/**
 * Tell the other tabs this document's session just changed (a sign-in, a
 * 2FA verification, a sign-up), before the flow navigates anywhere: the auth
 * client calls it on Better Auth's session signal, so the announcement
 * doesn't depend on the destination page running a guard or the watcher.
 */
export function announceSessionChange(): void {
  peerChannel()?.postMessage("session-changed");
}

/** Tests only: a fresh document, with `open` as its peer-channel factory. */
export function resetDocumentIdentityForTests(
  open: () => IdentityChannel | undefined = openBroadcastChannel,
): void {
  Object.assign(documentIdentity, {
    baseline: undefined,
    replaced: false,
    leaving: false,
    heldPrivateState: false,
    quarantined: false,
    reloading: false,
  });
  replaceListeners.clear();
  identityUnverified = false;
  verificationGeneration = 0;
  verificationListeners.clear();
  sessionCheck = undefined;
  sessionCheckPending = false;
  openChannel = open;
  peers = undefined;
  peersOpened = false;
  announced = undefined;
  restoreWatched = false;
  titleBlanked = false;
}
