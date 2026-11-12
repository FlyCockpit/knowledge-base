import { describe, expect, it } from "vitest";

import { assertKbRecoveryComplete, kbRecoveryGateOpen, setKbRecoveryComplete } from "./recovery";

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
