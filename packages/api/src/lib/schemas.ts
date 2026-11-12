import { z } from "zod";

/** Opaque entity primary key (cuid2-ish). */
export const entityId = z.string().min(1).max(64);

/**
 * Short user-facing string: titles, names, one-line labels.
 *
 * Trimmed and non-empty. A name these schemas describe as "text" must not
 * accept `""` or `"   "` — a blank title renders as an empty row the user
 * cannot see or click, and every caller so far would have had to re-add the
 * check itself. Fields that are genuinely optional should say so with
 * `.optional()` rather than by allowing an empty string.
 */
export const shortText = z.string().trim().min(1).max(200);

/** Long user-facing string: bodies, descriptions, markdown. Trimmed, non-empty. */
export const longText = z.string().trim().min(1).max(10_000);

/**
 * Opaque pagination cursor token — string bounds only. The format check lives
 * in `pagination.ts` (`cursorTokenSchema`), which is what procedure inputs use.
 */
export const cursorToken = z.string().trim().min(1).max(128);

/**
 * Same-origin path only. Rejects protocol-relative (`//host`) and absolute
 * (`https://…`) URLs so a value we later hand to `location.assign` cannot
 * navigate the visitor off-site.
 *
 * A backslash is treated as a path separator here because the WHATWG URL
 * parser normalizes `\` to `/` for special schemes — so `/\evil.com` would
 * otherwise resolve to the protocol-relative `//evil.com`. Reject backslashes
 * (and ASCII control characters, which browsers strip before parsing) rather
 * than let either smuggle an off-site navigation past the `/`-prefix check.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally rejecting C0/DEL control chars that browsers strip pre-parse.
const CONTROL_OR_BACKSLASH = /[\\\u0000-\u001f\u007f]/;
export const pathOnlyUrl = z
  .string()
  .max(2000)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !value.includes("://") &&
      !CONTROL_OR_BACKSLASH.test(value),
    {
      message: "Must be a same-origin path starting with /",
    },
  );

/** Unicode scalar count, or null when the value contains an unpaired surrogate. */
export function countUnicodeScalars(value: string): number | null {
  let count = 0;
  for (const scalar of value) {
    if (scalar.length === 1) {
      const code = scalar.charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdfff) return null;
    }
    count += 1;
  }
  return count;
}

/** Character bounds counted in Unicode scalar values; unpaired surrogates are rejected. */
export function refineUnicodeScalarBounds(
  value: string,
  ctx: z.RefinementCtx,
  bounds: { min?: number; max?: number },
): void {
  const scalars = countUnicodeScalars(value);
  if (scalars === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
    });
    return;
  }
  if (bounds.min !== undefined && scalars < bounds.min) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_small,
      origin: "string",
      minimum: bounds.min,
      inclusive: true,
    });
  }
  if (bounds.max !== undefined && scalars > bounds.max) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_big,
      origin: "string",
      maximum: bounds.max,
      inclusive: true,
    });
  }
}

/**
 * Metadata names forbid C0/DEL. Descriptions are embedded verbatim in the
 * generated index.md, so they follow the Markdown control policy: C0 (including
 * storage-forbidden NUL) and DEL are rejected except tab, line feed and
 * carriage return.
 */
function kbMetadataTextSchema(field: "name" | "description", bounds: { min: number; max: number }) {
  return z.string().superRefine((value, ctx) => {
    refineUnicodeScalarBounds(value, ctx, bounds);
    const forbidden =
      field === "name"
        ? Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
        : Array.from(value).some((c) => {
            const code = c.charCodeAt(0);
            return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
          });
    if (forbidden) ctx.addIssue({ code: z.ZodIssueCode.custom });
  });
}
export const kbNameSchema = kbMetadataTextSchema("name", { min: 1, max: 120 });
export const kbDescriptionSchema = kbMetadataTextSchema("description", { min: 10, max: 2000 });
