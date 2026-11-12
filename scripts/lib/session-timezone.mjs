/**
 * Shared guard for the two runtimes that pin a PostgreSQL session `TimeZone`
 * with node-pg's `options` startup parameter: the Prisma adapter factory
 * (`packages/db/src/prisma-adapter.ts`) and the schema migration runner
 * (`scripts/db/migrate-runtime.mjs`).
 *
 * node-pg's `ConnectionParameters` merges the parsed connection string OVER
 * the config object (`Object.assign({}, config, parse(config.connectionString))`),
 * so an `options` query parameter in `DATABASE_URL` replaces the pin and makes
 * the session follow that value instead. Prisma timestamps and legacy
 * conversions preserve their instants only while the session is UTC (the Prisma
 * adapter sends offset-less UTC text; `ALTER … SET DATA TYPE TIMESTAMPTZ` reads
 * legacy wall-clock values in the session zone), so a smuggled `options=` is a silent correctness
 * failure, not a preference. Reject it at the boundary instead of trusting the
 * startup packet to survive every operator-supplied URL.
 * Literal C0 controls are rejected before inspecting query keys: the driver's
 * WHATWG URL parser removes TAB/LF/CR anywhere, turning `op\ttions` into `options`,
 * and trims other trailing C0 controls (even an empty `?options` erases the pin).
 * Encoded characters stay encoded during URL normalization and remain supported.
 *
 * Scope note: node-pg reads the startup parameter from the exact lowercase
 * `options` key, and `pg-connection-string` builds keys verbatim from the URL
 * query string, so a differently-cased `Options=` is inert. This guard rejects
 * it anyway — there is no legitimate reason to pass a session `options` value
 * through `DATABASE_URL`, and an inert near-miss is a future lead, not a safe
 * spelling.
 *
 * Why only the pin sites call this: the guard exists to keep a *pin* from being
 * replaced. The raw `pg` clients (`lock.ts`, `search.ts`, `generations.ts`,
 * `query-embedding.ts`) pin no zone, and do not need to — node-pg serializes a
 * `Date` parameter with an explicit `±HH:MM` offset, PostgreSQL always renders a
 * `timestamptz` with its offset, and `pnpm policy:timestamps` rule 3 rejects the
 * session-dependent SQL spellings (offset-less literals, date truncation and
 * casts, variable-length intervals) that are the only way a session zone could
 * become load-bearing there. A raw client that later needs a pin belongs behind
 * this guard too.
 */

/** Query keys (`options`, case-insensitively) present in a connection string. */
function queryKeys(connectionString) {
  const question = connectionString.indexOf("?");
  if (question < 0) return [];
  const hash = connectionString.indexOf("#", question);
  const query = connectionString.slice(question + 1, hash < 0 ? undefined : hash);
  return query
    .split("&")
    .map((pair) => pair.split("=", 1)[0])
    .filter(Boolean)
    .map((key) => {
      try {
        return decodeURIComponent(key);
      } catch {
        return key;
      }
    });
}

/** @param {string} connectionString @param {string} pinLabel */
export function assertNoSessionOptionOverride(connectionString, pinLabel) {
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new Error(`${pinLabel}: refusing an empty connection string.`);
  }
  // Keep this pre-parse rejection in sync with the Prisma adapter guard.
  for (const character of connectionString) {
    if (character.charCodeAt(0) < 32) {
      throw new Error(
        `${pinLabel}: refusing literal TAB/LF/CR or other C0 control characters in DATABASE_URL. Percent-encode these characters.`,
      );
    }
  }
  if (queryKeys(connectionString).some((key) => key.toLowerCase() === "options")) {
    throw new Error(
      `${pinLabel}: refusing an \`options\` query parameter in DATABASE_URL. It overrides the pinned ` +
        "`-c TimeZone=UTC` startup parameter and silently shifts every stored timestamp. Remove it " +
        "from the connection string.",
    );
  }
}
