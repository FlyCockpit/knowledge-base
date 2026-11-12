/**
 * Pure helpers for the local-dev `SMTP_*` lines in a root `.env` file's
 * contents.
 *
 * First login needs a mail sink: email verification is enforced on signup, so
 * without SMTP the developer can never click the verification link. The dev
 * compose stack ships a mailpit sink on localhost:1025, and `pnpm run setup`
 * activates these lines so day-one works with zero manual .env editing.
 *
 * No file I/O here — `scripts/setup.ts` owns reading/writing the file;
 * keeping the line-editing logic pure makes it unit-testable without
 * touching disk. See scripts/lib/smtp-env.test.ts.
 */

const SMTP_HOST_LINE = /^(\s*)#?\s*SMTP_HOST\s*=/;
const SMTP_PORT_LINE = /^(\s*)#?\s*SMTP_PORT\s*=/;
const SMTP_FROM_LINE = /^(\s*)#?\s*SMTP_FROM\s*=/;

/** The dev sink values setup writes when nothing real is configured. */
export const DEV_SINK = {
  host: "localhost",
  port: "1025",
  from: "noreply@dev.local",
} as const;

/**
 * The current active `SMTP_HOST` value in env-file contents, or `null` when
 * the line is absent, commented out, or empty. Callers use `null` as "safe to
 * point at the local sink" — a real provider configured by the developer is
 * never touched.
 */
export function readSmtpHostValue(envContents: string): string | null {
  for (const raw of envContents.split("\n")) {
    if (raw.trim().startsWith("#")) continue;
    const match = raw.match(/^(\s*)SMTP_HOST\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const value = (match[2] ?? "").replace(/^["']|["']$/g, "");
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Activate the `SMTP_HOST` / `SMTP_PORT` / `SMTP_FROM` lines in env-file
 * contents, pointing them at the local dev mail sink. A no-op (returns the
 * input unchanged) when `SMTP_HOST` already has a non-empty value — this is
 * what makes re-running setup idempotent and what keeps a real provider's
 * settings intact. Commented `# SMTP_*=` template lines are uncommented in
 * place; missing lines are appended.
 */
export function withDevSmtpSink(envContents: string): string {
  if (readSmtpHostValue(envContents) !== null) return envContents;

  const lines = envContents.split("\n");
  const replaced = { host: false, port: false, from: false };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    let match = line.match(SMTP_HOST_LINE);
    if (match && !replaced.host) {
      lines[i] = `${match[1]}SMTP_HOST=${DEV_SINK.host}`;
      replaced.host = true;
      continue;
    }
    match = line.match(SMTP_PORT_LINE);
    if (match && !replaced.port) {
      lines[i] = `${match[1]}SMTP_PORT=${DEV_SINK.port}`;
      replaced.port = true;
      continue;
    }
    match = line.match(SMTP_FROM_LINE);
    if (match && !replaced.from) {
      lines[i] = `${match[1]}SMTP_FROM=${DEV_SINK.from}`;
      replaced.from = true;
    }
  }

  const append: string[] = [];
  if (!replaced.host) append.push(`SMTP_HOST=${DEV_SINK.host}`);
  if (!replaced.port) append.push(`SMTP_PORT=${DEV_SINK.port}`);
  if (!replaced.from) append.push(`SMTP_FROM=${DEV_SINK.from}`);
  if (append.length > 0) {
    // Append as a block after the last non-empty line so the file keeps its
    // trailing structure.
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push("", ...append);
  }

  return lines.join("\n");
}
