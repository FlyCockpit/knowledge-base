/** The KB read/write gate that journal recovery opens. Its own module so that
 * readers (and the pre-receive hook through them) depend on the flag, not on
 * the recovery machinery and its operation graph. */
let recoveryComplete = false;

export function kbRecoveryGateOpen(): boolean {
  return recoveryComplete;
}

export function assertKbRecoveryComplete(): void {
  if (!recoveryComplete) {
    throw new Error("KB reads are blocked until journal recovery completes");
  }
}

export function setKbRecoveryComplete(value: boolean): void {
  recoveryComplete = value;
}
