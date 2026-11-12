/**
 * Pure helpers for the `ADMIN_EMAIL` line in a root `.env` file's contents.
 *
 * No file I/O here — `scripts/setup.ts` owns reading/writing the file and
 * prompting the developer; keeping the line-editing logic pure makes it
 * unit-testable without touching disk. See scripts/setup.test.ts.
 */

const ADMIN_EMAIL_LINE = /^(\s*)ADMIN_EMAIL\s*=\s*(.*?)\s*$/;

/**
 * The current `ADMIN_EMAIL` value in env-file contents, or `null` when the
 * line is absent, commented out, or present but empty. Callers use `null` as
 * "safe to set".
 */
export function readAdminEmailValue(envContents: string): string | null {
  for (const raw of envContents.split("\n")) {
    if (raw.trim().startsWith("#")) continue;
    const match = raw.match(ADMIN_EMAIL_LINE);
    if (!match) continue;
    const value = (match[2] ?? "").replace(/^["']|["']$/g, "");
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Insert `ADMIN_EMAIL=<email>` into env-file contents. A no-op (returns the
 * input unchanged) when `ADMIN_EMAIL` is already set to a non-empty value —
 * this is what makes re-running setup idempotent. An existing empty
 * `ADMIN_EMAIL=` line is replaced in place; otherwise the line is appended.
 */
export function withAdminEmail(envContents: string, email: string): string {
  if (readAdminEmailValue(envContents) !== null) return envContents;

  const lines = envContents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.trim().startsWith("#")) continue;
    const match = line.match(ADMIN_EMAIL_LINE);
    if (!match) continue;
    lines[i] = `${match[1]}ADMIN_EMAIL=${email}`;
    return lines.join("\n");
  }

  lines.push(`ADMIN_EMAIL=${email}`);
  return lines.join("\n");
}

/** Loose validation: good enough to catch a typo, not an RFC 5322 parser. */
export function looksLikeEmail(value: string): boolean {
  return value.includes("@") && !value.includes(",");
}
