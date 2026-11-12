/**
 * Search-param contract for `/$lang/verify-email`.
 *
 * Lives here rather than inline in the route so it can be unit tested against
 * the router's real search parser — the bug this guards against is invisible
 * unless you run the marker through that parser, and route files must not
 * export anything.
 * See AGENTS.md § Performance — Bundle Splitting and Dynamic Imports
 *
 * Same shape as `view-transition-policy.ts`: a pure function the router config
 * consumes.
 *
 * The landing page has three states, and they are driven entirely by these two
 * params:
 *
 *   ?ok=1              → verified (Better-Auth redirected here on success)
 *   ?error=<CODE>      → the token was bad, expired, or already used
 *   neither            → "we don't know" — render the resend form
 *
 * `error` wins over `ok`: a failed hop arrives as `?ok=1&error=<CODE>`, because
 * Better-Auth appends its code to the callbackURL we already built.
 */
export type VerifyEmailSearch = {
  error: string | undefined;
  ok: true | undefined;
};

export function parseVerifyEmailSearch(search: Record<string, unknown>): VerifyEmailSearch {
  return {
    error: typeof search.error === "string" ? search.error : undefined,
    // Accept every spelling of the success marker. The router parses search
    // values with `JSON.parse`, so the `?ok=1` that `buildCallback`
    // (packages/auth/src/verification-callback.ts) emits arrives as the NUMBER
    // 1 — not the string "1". Matching only the string made the success state
    // unreachable: every genuinely verified user fell through to the "you still
    // need to verify" branch and was told to request another link, forever.
    //
    // The marker is built in a different package from the one that reads it, so
    // be permissive here rather than coupling the two spellings.
    ok: search.ok === 1 || search.ok === "1" || search.ok === true ? true : undefined,
  };
}
