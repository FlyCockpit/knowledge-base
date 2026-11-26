import { describe, expect, it } from "vitest";
import { listAccountTeardownHandlersForTests } from "./account-removal";
import {
  mirrorConfigureInput,
  mirrorStatusSchema,
  registerMirrorExecutor,
  requireMirrorExecutor,
  resetMirrorExecutorForTests,
  teardownMirror,
} from "./mirror";
import { listTransferLifecycleHandlersForTests } from "./transfer";

describe("mirror lifecycle wiring", () => {
  it("registers the same teardown for transfer and for tombstone/account removal", () => {
    expect(listTransferLifecycleHandlersForTests()).toContain(teardownMirror);
    expect(listAccountTeardownHandlersForTests()).toContain(teardownMirror);
  });

  it("requires an explicit executor drain port and refuses silently missing ones", () => {
    resetMirrorExecutorForTests();
    expect(() => requireMirrorExecutor()).toThrow(
      expect.objectContaining({ code: "STORAGE_UNAVAILABLE" }),
    );
    const port = { drain: async () => {} };
    registerMirrorExecutor(port);
    expect(requireMirrorExecutor()).toBe(port);
    resetMirrorExecutorForTests();
  });
});

describe("mirror wire schemas", () => {
  it("configure input is closed and bounded", () => {
    const base = {
      kbId: "a".repeat(24),
      url: "ssh://git@git.example.com/o/r.git",
      hostKeys: ["ssh-ed25519 AAAA"],
      hostKeyCheck: "CONFIRMED",
      idempotencyKey: "k".repeat(16),
    };
    expect(mirrorConfigureInput.safeParse(base).success).toBe(true);
    // Host keys are never accepted without saying how they were approved.
    const { hostKeyCheck: _omit, ...unapproved } = base;
    expect(mirrorConfigureInput.safeParse(unapproved).success).toBe(false);
    expect(mirrorConfigureInput.safeParse({ ...base, hostKeyCheck: "TOFU" }).success).toBe(false);
    expect(mirrorConfigureInput.safeParse({ ...base, privateKey: "x" }).success).toBe(false);
    expect(mirrorConfigureInput.safeParse({ ...base, hostKeys: [] }).success).toBe(false);
    expect(
      mirrorConfigureInput.safeParse({ ...base, hostKeys: Array(9).fill("ssh-ed25519 AAAA") })
        .success,
    ).toBe(false);
  });

  it("status projection strips anything that is not a public field", () => {
    const parsed = mirrorStatusSchema.parse({
      kbId: "a".repeat(24),
      state: "DISCONNECTED",
      remoteVersion: 2,
      active: null,
      pending: null,
      pushEnabled: false,
      ciphertext: "secret",
    });
    expect(parsed).not.toHaveProperty("ciphertext");
  });
});
