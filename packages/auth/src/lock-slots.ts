// Shared below auth so every identity/credential writer uses one counter and queue.
export {
  LockSlotTimeoutError,
  releaseSlots,
  tryAcquireSlots,
  withLockSlot,
} from "@knowledge-base/db/lock-slots";
