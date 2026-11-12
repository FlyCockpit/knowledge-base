import { describe, expect, it, vi } from "vitest";

import {
  createTwoFactorEnrollmentRunner,
  nextTwoFactorStep,
  type TwoFactorEnrollmentDeps,
  type TwoFactorEnrollmentStep,
} from "./use-two-factor-enrollment";

const messages = { startFailed: "start failed", enabled: "enabled", invalidCode: "bad code" };
const URI = "otpauth://totp/KB:a@example.test?secret=ABC";

function harness(overrides: Partial<TwoFactorEnrollmentDeps> = {}) {
  const events: string[] = [];
  const deps: TwoFactorEnrollmentDeps = {
    enable: vi.fn(async () => ({ data: { method: "totp", totpURI: URI, backupCodes: ["c1"] } })),
    verifyTotp: vi.fn(async () => ({})),
    setLoading: (loading) => events.push(`loading:${loading}`),
    toastError: (message) => events.push(`error:${message}`),
    toastSuccess: (message) => events.push(`success:${message}`),
    logError: (tag) => events.push(`log:${tag}`),
    reload: () => events.push("reload"),
    ...overrides,
  };
  return { deps, events, runner: createTwoFactorEnrollmentRunner(deps) };
}

/** A promise the test settles by hand, to hold a request in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("two-factor enrollment: enroll", () => {
  it("requests a TOTP secret with the password and returns it", async () => {
    const { deps, events, runner } = harness();
    await expect(runner.enroll("pw", messages, "_auth")).resolves.toEqual({
      totpURI: URI,
      backupCodes: ["c1"],
    });
    expect(deps.enable).toHaveBeenCalledWith({ password: "pw", method: "totp" });
    expect(events).toEqual(["loading:true", "loading:false"]);
  });

  it("defaults a missing URI and backup codes to empty values", async () => {
    const { runner } = harness({ enable: async () => ({ data: { method: "totp" } }) });
    await expect(runner.enroll("", messages, "_auth")).resolves.toEqual({
      totpURI: "",
      backupCodes: [],
    });
  });

  it("reports a server refusal with the screen's copy and log tag", async () => {
    const { events, runner } = harness({ enable: async () => ({ error: { status: 401 } }) });
    await expect(runner.enroll("wrong", messages, "settings.security")).resolves.toBeNull();
    expect(events).toEqual([
      "loading:true",
      "log:[settings.security.twoFactor.enable]",
      "error:start failed",
      "loading:false",
    ]);
  });

  it("refuses a non-TOTP answer without logging", async () => {
    const { events, runner } = harness({ enable: async () => ({ data: { method: "otp" } }) });
    await expect(runner.enroll("pw", messages, "_auth")).resolves.toBeNull();
    expect(events).toEqual(["loading:true", "error:start failed", "loading:false"]);
  });

  it("reports a thrown network error and releases the guard", async () => {
    const enable = vi
      .fn<TwoFactorEnrollmentDeps["enable"]>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ data: { method: "totp", totpURI: URI } });
    const { events, runner } = harness({ enable });
    await expect(runner.enroll("pw", messages, "_auth")).resolves.toBeNull();
    expect(events).toContain("log:[_auth.twoFactor.enable]");
    expect(events).toContain("error:start failed");
    // Retry works: the in-flight guard was released in `finally`.
    await expect(runner.enroll("pw", messages, "_auth")).resolves.toMatchObject({ totpURI: URI });
  });

  it("sends one request when enroll is triggered twice (Enter + click)", async () => {
    const pending = deferred<{ data: { method: string; totpURI: string } }>();
    const enable = vi.fn(() => pending.promise);
    const { deps, runner } = harness({ enable });
    const first = runner.enroll("pw", messages, "_auth");
    await expect(runner.enroll("pw", messages, "_auth")).resolves.toBeNull();
    // Verify shares the guard while enroll is in flight.
    await runner.verify("123456", messages, "_auth");
    expect(deps.verifyTotp).not.toHaveBeenCalled();
    pending.resolve({ data: { method: "totp", totpURI: URI } });
    await expect(first).resolves.toMatchObject({ totpURI: URI });
    expect(enable).toHaveBeenCalledTimes(1);
  });
});

describe("two-factor enrollment: verify", () => {
  it("enables 2FA with a six-digit code, then toasts and reloads", async () => {
    const { deps, events, runner } = harness();
    await runner.verify("123456", messages, "_auth");
    expect(deps.verifyTotp).toHaveBeenCalledWith({ code: "123456" });
    expect(events).toEqual(["loading:true", "success:enabled", "reload", "loading:false"]);
  });

  it("sends one request when verify is triggered twice, and allows a retry after", async () => {
    const pending = deferred<{ error?: unknown }>();
    const verifyTotp = vi.fn(() => pending.promise);
    const { events, runner } = harness({ verifyTotp });
    const first = runner.verify("123456", messages, "_auth");
    await runner.verify("123456", messages, "_auth");
    // No React rerender has occurred: the guard closes synchronously.
    expect(verifyTotp).toHaveBeenCalledOnce();
    expect(events).toEqual(["loading:true"]);
    pending.resolve({ error: { status: 400 } });
    await first;
    expect(events.at(-1)).toBe("loading:false");
    await runner.verify("123456", messages, "_auth");
    expect(verifyTotp).toHaveBeenCalledTimes(2);
  });

  it("ignores codes that are not six characters", async () => {
    const { deps, events, runner } = harness();
    for (const code of ["", "12345", "1234567"]) await runner.verify(code, messages, "_auth");
    expect(deps.verifyTotp).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("reports a rejected code and stays on the screen", async () => {
    const { events, runner } = harness({ verifyTotp: async () => ({ error: { status: 400 } }) });
    await runner.verify("000000", messages, "settings.security");
    expect(events).toEqual([
      "loading:true",
      "log:[settings.security.twoFactor.verifyTotp]",
      "error:bad code",
      "loading:false",
    ]);
  });

  it("reports a thrown error as an invalid code", async () => {
    const { events, runner } = harness({
      verifyTotp: async () => {
        throw new Error("offline");
      },
    });
    await runner.verify("000000", messages, "_auth");
    expect(events).toEqual([
      "loading:true",
      "log:[_auth.twoFactor.verifyTotp]",
      "error:bad code",
      "loading:false",
    ]);
    expect(events).not.toContain("reload");
  });
});

describe("two-factor enrollment: steps and cancel", () => {
  const walk = (events: Parameters<typeof nextTwoFactorStep>[1][]) =>
    events.reduce<TwoFactorEnrollmentStep>(nextTwoFactorStep, "start");

  it("walks start → password → secret → code", () => {
    expect(walk(["begin"])).toBe("password");
    expect(walk(["begin", "enrolled"])).toBe("secret");
    expect(walk(["begin", "enrolled", "saved"])).toBe("code");
  });

  it("cancel returns to start from every step", () => {
    for (const step of ["start", "password", "secret", "code"] as const)
      expect(nextTwoFactorStep(step, "cancel")).toBe("start");
  });

  it("a cancelled flow restarts with a fresh enable request", async () => {
    const { deps, runner } = harness();
    expect(walk(["begin", "cancel", "begin"])).toBe("password");
    await runner.enroll("pw", messages, "settings.security");
    await runner.enroll("pw", messages, "settings.security");
    expect(deps.enable).toHaveBeenCalledTimes(2);
  });
});
