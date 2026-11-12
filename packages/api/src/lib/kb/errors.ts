export type KbDomainCode =
  | "UNRESOLVED_REFERENCE"
  | "INVALID_ARGUMENT"
  | "INVALID_CURSOR"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "CONFLICT"
  | "IDEMPOTENCY_MISMATCH"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "INDEX_UNAVAILABLE"
  | "STORAGE_UNAVAILABLE"
  | "REPAIR_REQUIRED"
  | "UPLOAD_INCOMPLETE"
  | "UPLOAD_EXPIRED"
  | "CANCELLED"
  | "DEADLINE_EXCEEDED"
  | "INTERNAL";

export class KbDomainError extends Error {
  readonly code: KbDomainCode;
  readonly retryAfterSeconds?: number;

  constructor(
    code: KbDomainCode,
    message: string,
    retryAfterSeconds?: number,
    readonly details: unknown = {},
  ) {
    super(message);
    this.name = "KbDomainError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * An index file a read needed was absent (ENOENT / SQLITE_CANTOPEN under an existing index
 * directory). The outermost search operation may retry once (§1.7).
 */
export class IndexFileMissingError extends KbDomainError {
  constructor() {
    super("INDEX_UNAVAILABLE", "Index unavailable");
    this.name = "IndexFileMissingError";
  }
}

export function fromAdmissionError(error: unknown): KbDomainError | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code: string }).code;
  if (code === "NOT_FOUND") return new KbDomainError("NOT_FOUND", "Knowledge base not found");
  if (code === "FORBIDDEN") return new KbDomainError("FORBIDDEN", "Forbidden");
  if (code === "UNAUTHORIZED") return new KbDomainError("FORBIDDEN", "Forbidden");
  if (code === "RATE_LIMITED") {
    const retry = (error as { retryAfterSeconds?: number }).retryAfterSeconds;
    return new KbDomainError("RATE_LIMITED", "Rate limited", retry);
  }
  if (code === "QUOTA_EXCEEDED") return new KbDomainError("QUOTA_EXCEEDED", "Quota exceeded");
  if (code === "STORAGE_UNAVAILABLE") {
    return new KbDomainError("STORAGE_UNAVAILABLE", "Storage unavailable");
  }
  return null;
}

export function fromOperationIntentError(error: unknown): KbDomainError | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code: string }).code;
  switch (code) {
    case "IDEMPOTENCY_MISMATCH":
      return new KbDomainError("IDEMPOTENCY_MISMATCH", "Idempotency mismatch");
    case "UNAUTHORIZED":
      return new KbDomainError("FORBIDDEN", "Forbidden");
    case "NOT_FOUND":
      return new KbDomainError("NOT_FOUND", "Not found");
    case "REPAIR_REQUIRED":
      return new KbDomainError("REPAIR_REQUIRED", "Knowledge base requires repair");
    case "INTENT_CONFLICT":
    case "INVALID_STATE":
      return new KbDomainError("CONFLICT", "Conflict");
    default:
      return null;
  }
}
