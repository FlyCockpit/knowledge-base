import { isLiveHeldLease, KbLockError } from "@knowledge-base/api/lib/kb/lock";
import type { GitWriteCapability } from "@knowledge-base/api/lib/kb/write-capability";
// Deliberately private, with no package export: only the server composition root mints.
import { issuedCapabilities } from "../../../packages/api/src/lib/kb/write-capability-state.js";
import { assertProcessFence } from "./kb-process.js";

export function issueGitWriteCapability(lease: unknown, kbId: string): GitWriteCapability {
  assertProcessFence();
  if (!isLiveHeldLease(lease)) {
    throw new KbLockError("NOT_HELD", "Git write capability requires a live pinned session");
  }
  lease.assertHeldKb(kbId);
  lease.assertCanReceiveNetworkBody("issue a Git write capability");
  const capability = Object.freeze({ opId: lease.opId, kbId }) as GitWriteCapability;
  issuedCapabilities.add(capability);
  return capability;
}
