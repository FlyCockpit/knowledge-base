import { describe, expect, it } from "vitest";

import { KbLockError } from "./lock";
import {
  assertKbRecoveryComplete,
  isKbLocalRecoveryFailure,
  kbRecoveryGateOpen,
  mayQuarantine,
  RECOVERY_QUARANTINE_LIMIT_PER_PASS,
  setKbRecoveryComplete,
} from "./recovery";

describe("recovery gate", () => {
  it("blocks reads until recovery completes", () => {
    setKbRecoveryComplete(false);
    expect(kbRecoveryGateOpen()).toBe(false);
    expect(() => assertKbRecoveryComplete()).toThrow(/blocked/);
    setKbRecoveryComplete(true);
    expect(kbRecoveryGateOpen()).toBe(true);
    assertKbRecoveryComplete();
  });
});

describe("recovery failure isolation", () => {
  it("treats a KB's storage, Git and journal failures as its own", () => {
    expect(isKbLocalRecoveryFailure(Object.assign(new Error("io"), { code: "EIO" }))).toBe(true);
    expect(isKbLocalRecoveryFailure(Object.assign(new Error("git"), { status: 128 }))).toBe(true);
    expect(isKbLocalRecoveryFailure(new Error("Invalid push delta"))).toBe(true);
  });

  it("never quarantines on a database or KB-lock failure (those abort the sweep)", () => {
    const serialization = Object.assign(new Error("could not serialize"), {
      code: "40001",
      severity: "ERROR",
    });
    const timeout = Object.assign(new Error("canceling statement"), {
      code: "57014",
      severity: "ERROR",
    });
    expect(isKbLocalRecoveryFailure(serialization)).toBe(false);
    expect(isKbLocalRecoveryFailure(timeout)).toBe(false);
    expect(isKbLocalRecoveryFailure(new KbLockError("NOT_HELD", "transaction is closed"))).toBe(
      false,
    );
  });

  it("never quarantines on a host-level fault, which every KB would hit and which can clear", () => {
    for (const code of ["ENOSPC", "EMFILE", "ENFILE", "EAGAIN", "ENOMEM", "EROFS", "ETIMEDOUT"]) {
      expect(isKbLocalRecoveryFailure(Object.assign(new Error(code), { code })), code).toBe(false);
    }
  });

  it("leaves ambiguous failures to the per-pass count (one damaged repo vs git missing)", () => {
    // These can be one KB's or everyone's; mayQuarantine decides by how many failed.
    for (const error of [
      Object.assign(new Error("storage"), { code: "STORAGE_UNAVAILABLE" }),
      Object.assign(new Error("denied"), { code: "EACCES" }),
      Object.assign(new Error("spawnSync git ENOENT"), {
        code: "ENOENT",
        syscall: "spawnSync git",
      }),
    ]) {
      expect(isKbLocalRecoveryFailure(error)).toBe(true);
    }
  });

  it("quarantines only a small minority of the ACTIVE KBs in one pass", () => {
    expect(RECOVERY_QUARANTINE_LIMIT_PER_PASS).toBe(3);
    expect(mayQuarantine(1, 1)).toBe(false); // a single-KB instance never isolates
    expect(mayQuarantine(1, 2)).toBe(true);
    expect(mayQuarantine(2, 3)).toBe(false); // more than half
    expect(mayQuarantine(3, 100)).toBe(true);
    expect(mayQuarantine(4, 100)).toBe(false); // over the cap
    expect(mayQuarantine(0, 0)).toBe(true);
  });
});
