import { PrismaPg } from "@prisma/adapter-pg";

/**
 * Every Prisma `DateTime` column is `timestamptz(3)`. `@prisma/adapter-pg`
 * sends `Date` arguments as offset-less UTC wall-clock text and rewrites every
 * `timestamptz` result's offset to `+00:00`, so it is only correct on a session
 * whose `TimeZone` is UTC. Pin it in the startup packet so no server, database
 * or role default can shift an instant read or written through Prisma.
 *
 * `PGOPTIONS` cannot override the pin (the config key wins over the env
 * default), but an `options` query parameter in `DATABASE_URL` can: node-pg's
 * `ConnectionParameters` merges the parsed connection string over the config
 * object. `assertNoSessionOptionOverride` rejects that smuggling. The mirror in
 * `scripts/lib/session-timezone.mjs` is what the migration runner and restore tooling use, because
 * the scripts tree is not a TypeScript module.
 *
 * `pnpm policy:timestamps` forbids constructing `PrismaPg` anywhere else.
 */
export const PRISMA_SESSION_OPTIONS = "-c TimeZone=UTC";

/**
 * Query keys (`options`, case-insensitively) present in a connection string.
 * `new URL` rejects node-pg-legal host-less forms such as
 * `postgresql://user@/db`, so the raw query string is parsed directly after
 * rejecting literal C0 controls that the driver's URL parser would remove.
 */
function queryKeys(connectionString: string): string[] {
  const question = connectionString.indexOf("?");
  if (question < 0) return [];
  const hash = connectionString.indexOf("#", question);
  const query = connectionString.slice(question + 1, hash < 0 ? undefined : hash);
  return query
    .split("&")
    .map((pair) => pair.split("=", 1)[0] ?? "")
    .filter(Boolean)
    .map((key) => {
      try {
        return decodeURIComponent(key);
      } catch {
        return key;
      }
    });
}

/** Fail closed rather than let `DATABASE_URL` replace the pinned session zone. */
export function assertNoSessionOptionOverride(connectionString: string): void {
  if (connectionString.length === 0) {
    throw new Error("Prisma adapter: refusing an empty DATABASE_URL.");
  }
  // WHATWG URL parsing removes TAB/LF/CR anywhere and trims trailing C0 controls:
  // `op\ttions` or a trailing control after `?options` can replace/erase the pin.
  for (const character of connectionString) {
    if (character.charCodeAt(0) < 32) {
      throw new Error(
        "Prisma adapter: refusing literal TAB/LF/CR or other C0 control characters in DATABASE_URL. Percent-encode these characters.",
      );
    }
  }
  if (queryKeys(connectionString).some((key) => key.toLowerCase() === "options")) {
    throw new Error(
      "Prisma adapter: refusing an `options` query parameter in DATABASE_URL. It overrides the " +
        "pinned `-c TimeZone=UTC` startup parameter and silently shifts every stored timestamp. " +
        "Remove it from the connection string.",
    );
  }
}

export function createPrismaPgAdapter(config: {
  connectionString: string;
  max?: number;
}): PrismaPg {
  assertNoSessionOptionOverride(config.connectionString);
  return new PrismaPg({ ...config, options: PRISMA_SESSION_OPTIONS });
}
