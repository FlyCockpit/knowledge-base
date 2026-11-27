import { ORPCError } from "@orpc/client";

/** Stable refusal reasons shared by role changes, archive, and delete. */
export function userChangeErrorKey(error: unknown) {
  const data = error instanceof ORPCError ? error.data : undefined;
  const reason = data && typeof data === "object" && "reason" in data ? data.reason : undefined;
  switch (reason) {
    case "SELF_DEMOTION":
      return "admin:users.roleErrors.selfDemotion";
    case "LAST_ACTIVE_ADMIN":
      return "admin:users.roleErrors.lastActiveAdmin";
    case "USER_NOT_FOUND":
      return "admin:users.roleErrors.userNotFound";
    case "USER_CHANGE_CONFLICT":
      return "admin:users.roleErrors.conflict";
    default:
      return undefined;
  }
}
