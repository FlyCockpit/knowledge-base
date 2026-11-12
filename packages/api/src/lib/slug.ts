/**
 * Slug generation for user-facing URLs.
 *
 * A slug's job is to make a URL readable: `/blog/how-we-cut-load-times`, not
 * `/blog/clx7f9a2b0000qk3m8h2n4p1x`. Anything a user can share, type, or read
 * aloud should be addressed by one. A slug is the wrong choice for unguessable
 * URLs, which want an opaque `publicId` instead.
 */

// Lowercase alphanumerics separated by single dashes, no leading/trailing dash.
const MAX_SLUG_LENGTH = 120;

/**
 * Convert a human title into a URL-safe slug.
 *
 * Diacritics are folded rather than dropped ("Café" → "cafe") so accented
 * titles produce readable slugs instead of losing characters. Anything else
 * outside `[a-z0-9]` collapses to a single dash.
 *
 * Returns an empty string when the input has no usable characters (a title
 * that is entirely emoji or CJK, for example). Callers must handle that — see
 * `uniqueSlug`, which is where the fallback lives.
 */
export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFKD")
      // Strip combining marks left behind by NFKD decomposition.
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SLUG_LENGTH)
      // The slice can leave a trailing dash if it landed mid-separator.
      .replace(/-+$/g, "")
  );
}

/**
 * Find a free slug, appending `-2`, `-3`, … until one is available.
 *
 * `exists` is called with each candidate and should report whether that slug is
 * already taken — usually a `findUnique` on the model's unique slug column.
 *
 * Why this exists rather than being inlined at each call site: two posts titled
 * "Welcome" is not an edge case, it is Tuesday. Without a collision step the
 * second create fails on the unique constraint and surfaces to the author as an
 * opaque error about a field they never filled in.
 *
 * This is best-effort, not atomic: two concurrent creates can both observe the
 * same slug as free. Keep the `@unique` constraint on the column and handle the
 * P2002 error as a CONFLICT — this function reduces collisions to a rare race
 * rather than a routine failure. `packages/api/src/routers/cms/posts.ts` shows
 * the P2002 → CONFLICT half (client-supplied slug); wire `uniqueSlug` at create
 * time when the server derives the slug from a title.
 *
 * @param base     Output of `slugify()`. Empty input falls back to `fallback`.
 * @param exists   Returns true when the candidate is already taken.
 * @param fallback Used when `base` is empty (e.g. an all-emoji title).
 */
export async function uniqueSlug(
  base: string,
  exists: (candidate: string) => Promise<boolean>,
  fallback = "untitled",
): Promise<string> {
  const root = base || fallback;
  if (!(await exists(root))) return root;

  // Bounded so a pathological `exists` (or a very popular title) cannot spin
  // forever; past the cap we fall back to a random suffix, which always
  // terminates.
  for (let n = 2; n <= 50; n++) {
    const candidate = `${truncateForSuffix(root, `-${n}`)}-${n}`;
    if (!(await exists(candidate))) return candidate;
  }

  const random = Math.random().toString(36).slice(2, 8);
  return `${truncateForSuffix(root, `-${random}`)}-${random}`;
}

/** Keep `root + suffix` within MAX_SLUG_LENGTH without cutting the suffix. */
function truncateForSuffix(root: string, suffix: string): string {
  const room = MAX_SLUG_LENGTH - suffix.length;
  return root.length <= room ? root : root.slice(0, room).replace(/-+$/g, "");
}
