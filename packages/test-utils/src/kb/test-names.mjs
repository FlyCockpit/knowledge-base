/**
 * Docker name prefix for `pnpm test:kb` (`TEST_CONTAINER_PREFIX`). Every Docker
 * name a run chooses (the compose project and so its containers, networks and
 * volumes, image tags, the named fixture containers, networks and volumes, and
 * the build-only `standalone` namespace) starts with it, so two checkouts can
 * run the suites side by side, and each one's dead-run reaper only ever
 * considers names in its own namespace. Unset means no prefix (the historical
 * names). Random names stay as they are (unnamed `docker run --rm` containers,
 * BuildKit `kb-build-<uuid>` build names): they cannot collide.
 *
 * Accepted: lowercase letters, digits and inner dashes, at most 32 characters
 * (Docker compose project, container and image-repository names all allow it).
 * A trailing dash is optional; the prefix is always joined with one. A prefix
 * may not contain `kb-test` or start with `kb-`: run names are parsed as
 * `<prefix>kb-test-<suite>-<pid>-<hex>`, and such a prefix could make one
 * namespace's names parse as another's (a different, possibly dead, run).
 */
const PREFIX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function kbTestNamePrefix(env = process.env) {
  const raw = env.TEST_CONTAINER_PREFIX ?? "";
  if (raw === "") return "";
  const value = raw.endsWith("-") ? raw.slice(0, -1) : raw;
  if (!PREFIX.test(value) || value.includes("kb-test") || value.startsWith("kb-")) {
    throw new Error(
      "TEST_CONTAINER_PREFIX must be lowercase letters, digits and inner dashes (at most 32 characters), not starting with kb- or containing kb-test",
    );
  }
  return `${value}-`;
}

/** `base` in this run's namespace. */
export function kbTestName(base, env = process.env) {
  return `${kbTestNamePrefix(env)}${base}`;
}

/** The prefix escaped for a RegExp source (it holds only [a-z0-9-]). */
export function kbTestNamePrefixPattern(env = process.env) {
  return kbTestNamePrefix(env).replaceAll("-", "\\-");
}
