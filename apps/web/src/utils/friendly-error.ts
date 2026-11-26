/**
 * Map an unknown error (oRPC ORPCError, fetch error, thrown Error) to safe
 * user-facing copy. Never returns `error.message` — that may contain raw
 * Prisma / auth.api / third-party SDK strings.
 *
 * Mapped copy lives in the `errors` locale namespace so every locale gets it.
 * Pass an optional `fallback` for context-specific copy ("Couldn't update
 * that user. Try again."). It is used only when we have no specific code
 * mapping; known codes (CONFLICT, FORBIDDEN, …) still return their mapped
 * copy, and so does a network failure (offline / server unreachable), which
 * says what to do instead of "Something didn't work".
 */
import i18n from "../i18n";
import { networkFailureKind } from "../lib/network-failure";

export function friendly(error: unknown, fallback?: string): string {
  const e = asErrorShape(error);
  const generic = fallback ?? i18n.t("errors:generic");

  const network = networkFailureKind(error);
  if (network === "offline") return i18n.t("errors:offline");
  if (network === "unreachable") return i18n.t("errors:unreachable");

  if (!e) return generic;

  if (e.code === "TOO_MANY_REQUESTS" || e.status === 429) {
    const retryAfter = getRetryAfter(e);
    return retryAfter !== null
      ? i18n.t("errors:rateLimitedWithSeconds", { seconds: retryAfter })
      : i18n.t("errors:rateLimited");
  }

  if (e.code === "UNAUTHORIZED" || e.status === 401) {
    return i18n.t("errors:sessionEnded");
  }
  if (e.code === "FORBIDDEN" || e.status === 403) {
    return i18n.t("errors:forbidden");
  }
  if (e.code === "NOT_FOUND" || e.status === 404) {
    return i18n.t("errors:notFound");
  }
  if (e.code === "CONFLICT" || e.status === 409) {
    return i18n.t("errors:conflict");
  }
  if (e.code === "BAD_REQUEST" || e.status === 400) {
    return i18n.t("errors:badRequest");
  }
  if (e.code === "INTERNAL_SERVER_ERROR" || (typeof e.status === "number" && e.status >= 500)) {
    return fallback ?? i18n.t("errors:serverError");
  }

  return generic;
}

/**
 * True if the error looks like a 429 / TOO_MANY_REQUESTS response from oRPC.
 */
export function isRateLimit(error: unknown): boolean {
  const e = asErrorShape(error);
  if (!e) return false;
  return e.status === 429 || e.code === "TOO_MANY_REQUESTS";
}

/**
 * True for a NOT_FOUND / 404 answer. A query answering this renders it as
 * the page's own state, so the global query toast skips it (`router.tsx`).
 */
export function isNotFound(error: unknown): boolean {
  const e = asErrorShape(error);
  if (!e) return false;
  return e.status === 404 || e.code === "NOT_FOUND";
}

/**
 * True for Better-Auth's answer to a wrong email or password (401
 * `INVALID_EMAIL_OR_PASSWORD`). Only that belongs under the sign-in password
 * field: a field error blocks resubmitting until the field changes, which is
 * wrong for a server error or a rate limit (docs/ui.md § Server errors on a field).
 */
export function isCredentialRejection(error: unknown): boolean {
  const e = asErrorShape(error);
  // The code only, not any 401: Better-Auth also answers 401
  // `FAILED_TO_CREATE_SESSION` after correct credentials.
  return e?.code === "INVALID_EMAIL_OR_PASSWORD";
}

/**
 * True for Better-Auth's answer to a wrong or expired one-time code (2FA app
 * code, emailed code, backup code). Only that belongs under the code field;
 * a rate limit, a lockout, an expired 2FA session or a server/network failure
 * is not the code's fault and goes to `friendly()` instead.
 */
export function isCodeRejection(error: unknown): boolean {
  const e = asErrorShape(error);
  if (!e) return false;
  return (
    e.code === "INVALID_CODE" || e.code === "INVALID_BACKUP_CODE" || e.code === "OTP_HAS_EXPIRED"
  );
}

type ErrorShape = {
  status?: number;
  code?: string;
  data?: unknown;
  cause?: unknown;
  message?: string;
};

function asErrorShape(error: unknown): ErrorShape | null {
  if (!error || typeof error !== "object") return null;
  return error as ErrorShape;
}

function getRetryAfter(e: ErrorShape): number | null {
  const fromData =
    e.data && typeof e.data === "object" && "retryAfter" in e.data
      ? (e.data as { retryAfter?: unknown }).retryAfter
      : undefined;
  const fromCause =
    e.cause && typeof e.cause === "object" && "retryAfter" in e.cause
      ? (e.cause as { retryAfter?: unknown }).retryAfter
      : undefined;
  const raw = fromData ?? fromCause;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}
