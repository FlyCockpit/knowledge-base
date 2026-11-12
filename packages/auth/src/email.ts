/**
 * Env-free identity helpers. Library code (for example KB share invites) imports this
 * instead of `./bootstrap`, which validates server env at import.
 */
export function canonicalizeEmail(email: unknown): string | undefined {
  if (typeof email !== "string") return undefined;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}
