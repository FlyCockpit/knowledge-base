import { KbLockError } from "./lock";
import { issuedCapabilities } from "./write-capability-state";

// The brand is type-only; the server-owned mint records actual objects privately.
declare const brand: unique symbol;
export type GitWriteCapability = {
  readonly [brand]: "issued";
  readonly opId: string;
  readonly kbId: string;
};

export function assertGitWriteCapability(value: unknown, kbId?: string): GitWriteCapability {
  if (!value || typeof value !== "object" || !issuedCapabilities.has(value)) {
    throw new KbLockError(
      "NOT_HELD",
      "Git write capability is missing or was not issued by the server coordinator",
    );
  }
  const capability = value as GitWriteCapability;
  if (kbId && capability.kbId !== kbId) {
    throw new KbLockError(
      "NOT_HELD",
      "Git write capability does not match this knowledge-base",
      capability.opId,
    );
  }
  return capability;
}

export function isGitWriteCapability(value: unknown): value is GitWriteCapability {
  return typeof value === "object" && value !== null && issuedCapabilities.has(value);
}
