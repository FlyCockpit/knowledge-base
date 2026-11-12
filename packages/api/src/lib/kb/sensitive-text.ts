/**
 * Conservative credential-pattern floor for dream and embedding redaction paths
 * (the egress floor: text that leaves for a model provider). Provider token
 * shapes (AWS, GitHub, Slack, Google) are anchored on their fixed prefixes; the
 * shared cases live in `fixtures/sensitive-text.json`.
 * This is intentionally incomplete — it does not detect arbitrary secrets.
 */

const OPENAI_STYLE_KEY = /\bsk-[A-Za-z0-9_-]{10,}\b/g;
// Consume the entire block (or through EOF if unclosed), including windows
// that contain only key material and not the BEGIN header.
const PEM_PRIVATE_KEY =
  /-----BEGIN ((?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g;
// RFC 6750 b64token charset. The lookahead requires a digit or separator so
// plain-English phrases ("the bearer of", "Bearer authentication") stay prose.
const BEARER_TOKEN_TAIL = "(?=[A-Za-z0-9._~+/-]*[0-9._~+/-])[A-Za-z0-9._~+/-]{8,}=*";
/** `Bearer <token>` — the standard authorization-scheme literal. */
const BEARER_LITERAL = new RegExp(`\\bbearer\\p{White_Space}+${BEARER_TOKEN_TAIL}`, "giu");
/** Optional `Authorization:`-style prefix; redaction consumes the full token. */
const AUTHORIZATION_LITERAL =
  /\bauthorization\p{White_Space}*[:=]\p{White_Space}*(?:bearer\p{White_Space}+)?[A-Za-z0-9._~+/-]{8,}=*/giu;

/** AWS access key id: `AKIA` (long-term) or `ASIA` (temporary) + 16 characters. */
const AWS_ACCESS_KEY_ID = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
// A bare 40-character base64 run is far too common to flag, so the AWS secret
// key only counts next to its key name (env, INI, YAML or AWS CLI JSON). The
// key name is spelled case-insensitively by hand: an `i` flag would also let
// `ſ`/`K` (Kelvin) match, which the CLI port would then have to mirror.
const AWS_SECRET_KEY_NAME =
  "(?:[Aa][Ww][Ss][_-]?[Ss][Ee][Cc][Rr][Ee][Tt][_-]?(?:[Aa][Cc][Cc][Ee][Ss][Ss][_-]?)?[Kk][Ee][Yy]" +
  "|[Ss][Ee][Cc][Rr][Ee][Tt][_-]?[Aa][Cc][Cc][Ee][Ss][Ss][_-]?[Kk][Ee][Yy])";
const AWS_SECRET_ACCESS_KEY = new RegExp(
  `\\b${AWS_SECRET_KEY_NAME}\\b["']?[ \\t]*(?:=>|[:=])[ \\t]*["']?[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])`,
  "g",
);
/** GitHub classic, OAuth, user-to-server, server-to-server and refresh tokens. */
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{36,}(?![A-Za-z0-9_])/g;
/** GitHub fine-grained personal access token. */
const GITHUB_FINE_GRAINED_TOKEN = /\bgithub_pat_[A-Za-z0-9_]{22,}/g;
/** Slack bot, user, app-level, refresh and session tokens. */
const SLACK_TOKEN = /\bxox[abprs]-[A-Za-z0-9-]{10,}/g;
/** Google API key. */
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g;

const SCAN_PATTERNS = [
  OPENAI_STYLE_KEY,
  PEM_PRIVATE_KEY,
  AUTHORIZATION_LITERAL,
  BEARER_LITERAL,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  GITHUB_TOKEN,
  GITHUB_FINE_GRAINED_TOKEN,
  SLACK_TOKEN,
  GOOGLE_API_KEY,
] as const;
// Every scan pattern is global and module-private. `matchAll` clones its
// regex and `replace` resets `lastIndex`, so both use the shared patterns
// directly; `test` would advance a global regex's `lastIndex`, so it gets
// stateless non-global twins.
const TEST_PATTERNS = SCAN_PATTERNS.map(
  (pattern) => new RegExp(pattern.source, pattern.flags.replace("g", "")),
);

export function containsKnownCredentialPatterns(text: string): boolean {
  return TEST_PATTERNS.some((pattern) => pattern.test(text));
}

/** UTF-16 source ranges; callers translate only their source-window boundaries. */
export function knownCredentialRanges(text: string): { start: number; end: number }[] {
  return SCAN_PATTERNS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    })),
  ).sort((a, b) => a.start - b.start);
}

/** Strip credential-shaped substrings from operator-facing rejection text. */
export function redactSensitiveSubstrings(text: string): string {
  let out = text;
  // Authorization literals run before bare bearer literals so a header plus
  // token is consumed as one span instead of leaving the token behind.
  for (const pattern of SCAN_PATTERNS) {
    out = out.replace(pattern, "[redacted]");
  }
  return out;
}
