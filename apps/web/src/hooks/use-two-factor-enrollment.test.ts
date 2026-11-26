import { describe, expect, it, vi } from "vitest";

import {
  createTwoFactorEnrollmentRunner,
  nextTwoFactorStep,
  type TwoFactorEnrollmentDeps,
  type TwoFactorEnrollmentStep,
} from "./use-two-factor-enrollment";

vi.mock("../i18n", () => ({ default: { t: (key: string) => key } }));

const messages = {
  startFailed: "start failed",
  enabled: "enabled",
  invalidCode: "bad code",
  invalidPassword: "bad password",
};
const URI = "otpauth://totp/KB:a@example.test?secret=ABC";

function harness(overrides: Partial<TwoFactorEnrollmentDeps> = {}) {
  const events: string[] = [];
  const deps: TwoFactorEnrollmentDeps = {
    enable: vi.fn(async () => ({ data: { method: "totp", totpURI: URI, backupCodes: ["c1"] } })),
    verifyTotp: vi.fn(async () => ({})),
    setLoading: (loading) => events.push(`loading:${loading}`),
    toastError: (message) => events.push(`error:${message}`),
    fieldError: (field, message) => events.push(`field:${field}:${message}`),
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

  it("says a wrong password under the password field, not in a toast", async () => {
    const { events, runner } = harness({
      enable: async () => ({ error: { status: 400, code: "INVALID_PASSWORD" } }),
    });
    await expect(runner.enroll("wrong", messages, "_auth")).resolves.toBeNull();
    expect(events).toEqual([
      "loading:true",
      "log:[_auth.twoFactor.enable]",
      "field:password:bad password",
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

  it("says a rejected code under the code field and stays on the screen", async () => {
    const { events, runner } = harness({
      verifyTotp: async () => ({ error: { status: 401, code: "INVALID_CODE" } }),
    });
    await runner.verify("000000", messages, "settings.security");
    expect(events).toEqual([
      "loading:true",
      "log:[settings.security.twoFactor.verifyTotp]",
      "field:code:bad code",
      "loading:false",
    ]);
  });

  it("toasts a rate limit or server failure and leaves the code field alone", async () => {
    for (const [error, toast] of [
      [{ status: 429, code: "TOO_MANY_REQUESTS" }, "error:errors:rateLimited"],
      [{ status: 403, code: "ACCOUNT_TEMPORARILY_LOCKED" }, "error:errors:forbidden"],
      // Not the code's fault: the generic server copy, never "invalid code".
      [{ status: 503 }, "error:errors:serverError"],
    ] as const) {
      const { events, runner } = harness({ verifyTotp: async () => ({ error }) });
      await runner.verify("123456", messages, "_auth");
      expect(events).toEqual([
        "loading:true",
        "log:[_auth.twoFactor.verifyTotp]",
        toast,
        "loading:false",
      ]);
    }
  });

  it("reports a thrown error in a toast, not under the field", async () => {
    const { events, runner } = harness({
      verifyTotp: async () => {
        throw new Error("offline");
      },
    });
    await runner.verify("000000", messages, "_auth");
    expect(events).toEqual([
      "loading:true",
      "log:[_auth.twoFactor.verifyTotp]",
      "error:errors:generic",
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

  it("ignores an enable answer that arrives after Cancel", async () => {
    const pending = deferred<{ data: { method: string; totpURI: string } }>();
    const { events, runner } = harness({ enable: vi.fn(() => pending.promise) });
    const first = runner.enroll("pw", messages, "_auth");
    runner.cancel();
    expect(events).toEqual(["loading:true", "loading:false"]);
    pending.resolve({ data: { method: "totp", totpURI: URI } });
    // No secret: the screen stays at its start instead of jumping back to enrollment.
    await expect(first).resolves.toBeNull();
    expect(events).toEqual(["loading:true", "loading:false"]);
  });

  it("holds a new attempt until the cancelled request settles, and drops its refusal", async () => {
    const stale = deferred<{ error?: unknown }>();
    const fresh = deferred<{ data: { method: string; totpURI: string } }>();
    const enable = vi
      .fn<TwoFactorEnrollmentDeps["enable"]>()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise);
    const { events, runner } = harness({ enable });
    const first = runner.enroll("old", messages, "_auth");
    await Promise.resolve();
    expect(enable).toHaveBeenCalledTimes(1);
    runner.cancel();
    const second = runner.enroll("new", messages, "_auth");
    // Better-Auth's enable replaces an unverified secret: a second request now
    // could be overwritten by the cancelled one. The new attempt waits, loading.
    await new Promise((settle) => setTimeout(settle, 0));
    expect(enable).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["loading:true", "loading:false", "loading:true"]);
    stale.resolve({ error: { status: 400, code: "INVALID_PASSWORD" } });
    await expect(first).resolves.toBeNull();
    await new Promise((settle) => setTimeout(settle, 0));
    // Only now does the new request go out; the stale answer neither marks
    // the field nor ends the new attempt's loading.
    expect(enable).toHaveBeenCalledTimes(2);
    expect(enable).toHaveBeenLastCalledWith({ password: "new", method: "totp" });
    expect(events).toEqual(["loading:true", "loading:false", "loading:true"]);
    fresh.resolve({ data: { method: "totp", totpURI: URI } });
    await expect(second).resolves.toMatchObject({ totpURI: URI });
    expect(events.at(-1)).toBe("loading:false");
  });

  it("waits for a cancelled request that fails by throwing too", async () => {
    let rejectStale!: (error: unknown) => void;
    const thrown = new Promise<never>((_, reject) => {
      rejectStale = reject;
    });
    const enable = vi
      .fn<TwoFactorEnrollmentDeps["enable"]>()
      .mockImplementationOnce(() => thrown)
      .mockResolvedValueOnce({ data: { method: "totp", totpURI: URI } });
    const { events, runner } = harness({ enable });
    const first = runner.enroll("old", messages, "_auth");
    await Promise.resolve();
    runner.cancel();
    const second = runner.enroll("new", messages, "_auth");
    await new Promise((settle) => setTimeout(settle, 0));
    expect(enable).toHaveBeenCalledTimes(1);
    rejectStale(new TypeError("Failed to fetch"));
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toMatchObject({ totpURI: URI });
    expect(enable).toHaveBeenCalledTimes(2);
    // The cancelled attempt's failure is never toasted.
    expect(events.filter((event) => event.startsWith("error:"))).toEqual([]);
  });

  it("sends nothing for an attempt cancelled while it waited", async () => {
    const stale = deferred<{ data: { method: string; totpURI: string } }>();
    const enable = vi
      .fn<TwoFactorEnrollmentDeps["enable"]>()
      .mockImplementationOnce(() => stale.promise);
    const { runner } = harness({ enable });
    const first = runner.enroll("old", messages, "_auth");
    await Promise.resolve();
    runner.cancel();
    const second = runner.enroll("new", messages, "_auth");
    runner.cancel();
    stale.resolve({ data: { method: "totp", totpURI: URI } });
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(enable).toHaveBeenCalledTimes(1);
  });

  it("drops a cancelled verify's failure", async () => {
    const pending = deferred<{ error?: unknown }>();
    const { events, runner } = harness({ verifyTotp: vi.fn(() => pending.promise) });
    const first = runner.verify("123456", messages, "_auth");
    runner.cancel();
    pending.resolve({ error: { status: 401, code: "INVALID_CODE" } });
    await first;
    expect(events).toEqual(["loading:true", "loading:false", "log:[_auth.twoFactor.verifyTotp]"]);
  });

  it("a cancelled flow restarts with a fresh enable request", async () => {
    const { deps, runner } = harness();
    expect(walk(["begin", "cancel", "begin"])).toBe("password");
    await runner.enroll("pw", messages, "settings.security");
    await runner.enroll("pw", messages, "settings.security");
    expect(deps.enable).toHaveBeenCalledTimes(2);
  });
});
