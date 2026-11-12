function normalizeRoleToken(value: string): string {
  return value.trim().toLowerCase();
}

export function parseRoles(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map(normalizeRoleToken)
    .filter((role) => role.length > 0);
}

export function hasRole(value: unknown, expectedRole: string): boolean {
  const expected = normalizeRoleToken(expectedRole);
  return parseRoles(value).includes(expected);
}

export function isAdminRole(value: unknown): boolean {
  return hasRole(value, "admin");
}

/** Instance management cannot take over an existing user's private KB identity.
 * Omit generic `update` too: it can set emailVerified/twoFactorEnabled as well
 * as email, bypassing the dedicated account-management permissions.
 */
export const knowledgeBaseAdminPermissions = {
  user: ["create", "list", "set-role", "ban", "delete", "get"],
  session: ["list", "revoke", "delete"],
} as const;

/** Includes legacy sessions, even after their impersonator is removed/demoted. */
export function isImpersonatedSession(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("session" in value)) return false;
  const session = value.session;
  return (
    !!session &&
    typeof session === "object" &&
    "impersonatedBy" in session &&
    !!session.impersonatedBy
  );
}
