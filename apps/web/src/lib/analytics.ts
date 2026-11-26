/**
 * The single seam where analytics is allowed to load, and the app's one
 * analytics switch.
 *
 * The app ships NO analytics: `ANALYTICS_PROVIDER` is `null`. With no
 * provider there is nothing to ask consent for, so `analyticsConfigured` is
 * false and the consent UI stays off: no cookie banner, no "Cookie
 * preferences" button (public footer, settings), no reserved space at the
 * bottom of the shells, and `useAnalyticsConsent()` loads nothing. Sign-in
 * cookies and the stored theme and locale are strictly necessary and need no
 * consent.
 *
 * The switch is the provider itself, in code, not an environment variable:
 * turning analytics on and implementing it are the same edit, so the banner
 * cannot ask about analytics that is not there, and analytics cannot run
 * without the banner. `analytics.test.ts` fails a provider whose setup or
 * revocation is an empty function.
 *
 * THE RULE: never load an analytics script anywhere else — no `<script>` in
 * `index.html`, no tag in `__root.tsx`'s `head`, no `import` of a vendor SDK
 * at module scope. Any of those run before (or regardless of) consent, which
 * is the exact non-compliance this seam prevents.
 */

/** A provider's setup and its withdrawal, always written together. */
export interface AnalyticsProvider {
  /**
   * Called once, after the visitor has granted analytics consent. Example
   * (Plausible; adapt the src/domain, or use your own provider's tag):
   *
   * ```ts
   * const script = document.createElement("script");
   * script.defer = true;
   * script.dataset.domain = "example.com";
   * script.src = "https://plausible.io/js/script.js";
   * document.head.append(script);
   * ```
   */
  load(): void;
  /**
   * Called when consent is withdrawn. Use the provider's documented opt-out
   * API: stop collection, remove its script if applicable, and clear every
   * provider cookie and storage entry this origin can delete. Removing a
   * script tag alone does not stop an already-running SDK.
   */
  disable(): void;
}

/**
 * THE SWITCH. `null`: no analytics, no consent UI. To add a provider, set
 * this to `{ load() { … }, disable() { … } }`, and in the same change:
 *   1. Add the provider's origin to `script-src` / `connect-src` in
 *      `apps/server/src/security-headers.ts`. Add the specific host — never
 *      `'unsafe-eval'` or a wildcard (AGENTS.md § Agent Safety Rules).
 *   2. Name the cookies/storage it sets in your cookie policy.
 *   3. Check network requests and storage in the undecided, rejected,
 *      accepted, withdrawn and reloaded states.
 */
const ANALYTICS_PROVIDER: AnalyticsProvider | null = null;

/** The gate's view of one provider: load at most once while consent holds. */
interface AnalyticsSeam {
  /** True only when a provider exists; the consent UI renders only then. */
  readonly configured: boolean;
  load(): void;
  disable(): void;
  readonly loaded: () => boolean;
}

/**
 * Builds the seam around a provider (or none). Exported for the tests, which
 * exercise the switch both ways; the app uses the instance below.
 */
export function createAnalyticsSeam(provider: AnalyticsProvider | null): AnalyticsSeam {
  // Latch: consent can flip on more than once per page (another tab, a
  // re-decision), and the snippet must only ever run once while consent
  // remains granted. `disable()` clears it so a later re-grant can initialize
  // the provider again.
  let loaded = false;
  return {
    configured: provider !== null,
    load() {
      if (!provider || loaded) return;
      loaded = true;
      provider.load();
    },
    disable() {
      if (!provider || !loaded) return;
      loaded = false;
      provider.disable();
    },
    loaded: () => loaded,
  };
}

/** The shipped provider, for the guard in analytics.test.ts. */
export const analyticsProvider: AnalyticsProvider | null = ANALYTICS_PROVIDER;

const seam = createAnalyticsSeam(ANALYTICS_PROVIDER);

/** Whether this app has analytics, hence a consent banner. Off by default. */
export const analyticsConfigured: boolean = seam.configured;

/** Load the provider (once). Only `useAnalyticsConsent()` calls this. */
export function loadAnalytics(): void {
  seam.load();
}

/** Withdraw: the provider's opt-out and storage cleanup. */
export function disableAnalytics(): void {
  seam.disable();
}
