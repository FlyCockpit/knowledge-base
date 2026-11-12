/**
 * The single seam where analytics is allowed to load.
 *
 * This template ships NO analytics: `loadAnalytics()` and `disableAnalytics()`
 * are deliberate no-ops. They exist so that when you add Plausible, Umami,
 * Fathom, GA4 or anything else, loading and withdrawal have exactly one place
 * each — `useAnalyticsConsent()` calls them, and nothing else does.
 *
 * THE RULE: never load an analytics script anywhere else — no `<script>` in
 * `index.html`, no tag in `__root.tsx`'s `head`, no `import` of a vendor SDK
 * at module scope. Any of those run before (or regardless of) consent, which
 * is the exact non-compliance this seam prevents.
 */

// Module-scope latch: consent can flip on more than once per page (another
// tab, a re-decision), and the snippet must only ever run once while consent
// remains granted. `disableAnalytics()` clears it so a later re-grant can
// initialize a provider again.
let loaded = false;

/**
 * Called once, after the visitor has granted analytics consent.
 *
 * To wire up a provider, replace the body below with its snippet. Example
 * (Plausible — adapt the src/domain, or use your own provider's tag):
 *
 * ```ts
 * const script = document.createElement("script");
 * script.defer = true;
 * script.dataset.domain = "example.com";
 * script.src = "https://plausible.io/js/script.js";
 * document.head.append(script);
 * ```
 *
 * Three things to do in the same change:
 *   1. Add the provider's origin to `script-src` / `connect-src` in
 *      `apps/server/src/security-headers.ts`. Add the specific host — never
 *      `'unsafe-eval'` or a wildcard (AGENTS.md § Agent Safety Rules).
 *   2. Implement the matching provider opt-out and cleanup in
 *      `disableAnalytics()`: stop collection, remove its script if applicable,
 *      and clear every provider cookie and storage entry this origin can
 *      delete. Follow the provider's documented revocation API — removing a
 *      script tag alone does not stop an already-running SDK.
 *   3. Name the cookies/storage it sets in your cookie policy.
 */
export function loadAnalytics(): void {
  if (loaded) return;
  loaded = true;
  // No analytics provider configured — nothing to load. Paste your snippet
  // here (see the doc comment above).
}

/**
 * Stop analytics after consent is withdrawn.
 *
 * Keep this paired with `loadAnalytics()`: provider integrations must call the
 * provider's documented opt-out API and remove provider-owned storage that is
 * accessible from this origin. Do not merely remove a script element.
 */
export function disableAnalytics(): void {
  if (!loaded) return;
  loaded = false;
  // No analytics provider configured — add its opt-out and storage cleanup
  // here together with the setup in loadAnalytics().
}

/** Test-only visibility for the consent lifecycle. */
export function __analyticsLoadedForTests(): boolean {
  return loaded;
}

/** Test-only reset for isolated module-state assertions. */
export function __resetAnalyticsForTests(): void {
  loaded = false;
}
