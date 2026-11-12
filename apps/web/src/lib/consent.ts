/**
 * Cookie-consent core. No React, no UI — just the stored decision, the version
 * gate, and a subscribe/notify channel so every mounted consumer re-renders on
 * a change. The hook (`@/hooks/use-consent`) and the banner are thin wrappers.
 *
 * Only ONE optional category exists: `analytics`. Strictly necessary cookies
 * (the session, the CSRF token, the theme and locale preference) need no
 * consent under the ePrivacy Directive, so they are deliberately not a
 * category — a toggle that cannot be switched off is a dark pattern.
 *
 * Storage is `localStorage`, not a cookie: nothing server-side is gated on the
 * decision, so keeping it out of the request means no extra bytes on every
 * request and nothing to log.
 *
 * SSR-safe: every `window` access is guarded and wrapped in try/catch. Safari
 * private mode and "block all site data" both throw on `localStorage`, and a
 * consent banner that crashes the app is worse than one that re-asks.
 */

/**
 * Bump when the categories change meaning (a new category, a broader use of an
 * existing one). Both the key and the stored payload carry it, so an outgrown
 * decision reads as "undecided" and the visitor is asked again under the new
 * terms — which is what re-consent requires.
 */
export const CONSENT_VERSION = 1;

/** Versioned storage key — see `CONSENT_VERSION`. */
export const CONSENT_STORAGE_KEY = `knowledge-base.consent.v${CONSENT_VERSION}`;

/** A recorded decision, or `null` when the visitor has not chosen yet. */
export type ConsentState = { analytics: boolean; decidedAt: number } | null;

type StoredConsent = { v: number; analytics: boolean; decidedAt: number };

type Listener = () => void;

const listeners = new Set<Listener>();

// `useSyncExternalStore` requires a stable snapshot between renders, so the
// parsed value is cached by reference and recomputed only when a write (this
// tab) or a `storage` event (another tab) invalidates it. `undefined` means
// "not read yet"; `null` is a real value ("undecided").
let cache: ConsentState | undefined;

function parse(raw: string | null): ConsentState {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Partial<StoredConsent>;
  // A decision stored under an older version is treated as no decision, so the
  // banner reappears instead of silently carrying consent across a policy
  // change.
  if (value.v !== CONSENT_VERSION) return null;
  if (typeof value.analytics !== "boolean" || typeof value.decidedAt !== "number") return null;
  return { analytics: value.analytics, decidedAt: value.decidedAt };
}

/** The stored decision, or `null` when undecided. */
export function readConsent(): ConsentState {
  if (cache !== undefined) return cache;
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(CONSENT_STORAGE_KEY);
  } catch {
    // Private mode / blocked site data: behave as undecided, and do not cache
    // so a later grant of storage access is picked up.
    return null;
  }
  cache = parse(raw);
  return cache;
}

/** Server snapshot for `useSyncExternalStore` — always undecided. */
export function readServerConsent(): ConsentState {
  return null;
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Record a decision and notify every subscriber. */
export function writeConsent(analytics: boolean): ConsentState {
  const next: ConsentState = { analytics, decidedAt: Date.now() };
  cache = next;
  if (typeof window !== "undefined") {
    const payload: StoredConsent = { v: CONSENT_VERSION, ...next };
    try {
      window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Unwritable storage: the decision still holds for this page view, it
      // just will not survive a reload. Never throw at the visitor.
    }
  }
  notify();
  return next;
}

/**
 * Forget the decision so the banner reappears. Withdrawing consent must be as
 * easy as giving it — this is what the "Cookie preferences" button calls.
 */
export function clearConsent(): void {
  cache = null;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(CONSENT_STORAGE_KEY);
    } catch {
      // Same as above — the in-memory reset still takes effect.
    }
  }
  notify();
}

/**
 * Subscribe to decision changes. Also listens for `storage` events, so a
 * decision made in another tab is reflected here.
 */
export function subscribeConsent(listener: Listener): () => void {
  listeners.add(listener);
  if (typeof window === "undefined") {
    return () => {
      listeners.delete(listener);
    };
  }
  const onStorage = (event: StorageEvent) => {
    // `key === null` is a whole-storage clear, which also drops our key.
    if (event.key !== null && event.key !== CONSENT_STORAGE_KEY) return;
    cache = undefined;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Test-only: drop the in-memory snapshot so storage is re-read. */
export function __resetConsentCache(): void {
  cache = undefined;
}
