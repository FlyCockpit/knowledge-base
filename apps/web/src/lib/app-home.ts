/**
 * The signed-in home: where a signed-in user lands when they open the app,
 * finish signing in, click the brand in the app header, or visit the public
 * landing page (`/$lang/`, which forwards them here).
 *
 * The home is the knowledge bases list, not a stats page: it carries the
 * getting-started checklist and both lists ("Owned", "Shared with me"). See
 * docs/ui.md § The signed-in home.
 *
 * This is the one place to change it. The target must be a route under the
 * `_auth` gate (`routes/$lang/_app/_auth/`), so an expired session still falls
 * through to the login page. The old `/$lang/dashboard` URL forwards here
 * (`routes/$lang/dashboard.tsx`). The server's 2FA redirect fallback in
 * `packages/auth/src/index.ts` names the same path.
 */
export const APP_HOME = "/$lang/kbs" as const;

/** {@link APP_HOME} as a concrete href for one locale, e.g. `/en-US/kbs`. */
export function appHomeHref(lang: string): string {
  return APP_HOME.replace("$lang", lang);
}
