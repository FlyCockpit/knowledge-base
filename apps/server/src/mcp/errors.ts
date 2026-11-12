import { KbAdmissionError } from "@knowledge-base/api/lib/kb/principal";

/**
 * The OAuth signing-key service failed (not the token, not storage). Internally
 * it stays a retryable STORAGE_UNAVAILABLE-class admission failure so every
 * shared caller keeps its 503 handling; the MCP HTTP boundary names it.
 */
export class AuthServiceUnavailableError extends KbAdmissionError {
  constructor() {
    super("STORAGE_UNAVAILABLE", "Authorization key service unavailable");
  }
}

export function admissionErrorResponse(error: unknown, origin: string) {
  const code = error instanceof KbAdmissionError ? error.code : "STORAGE_UNAVAILABLE";
  const status = code === "UNAUTHORIZED" ? 401 : code === "FORBIDDEN" ? 403 : 503;
  return Response.json(
    {
      error:
        status === 401
          ? "UNAUTHORIZED"
          : status === 403
            ? "FORBIDDEN"
            : error instanceof AuthServiceUnavailableError
              ? "AUTH_UNAVAILABLE"
              : "STORAGE_UNAVAILABLE",
    },
    {
      status,
      headers: {
        "cache-control": "no-store",
        ...(status === 401
          ? {
              "www-authenticate": `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", origin).href}"`,
            }
          : {}),
      },
    },
  );
}
