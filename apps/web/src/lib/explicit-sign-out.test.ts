import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  signOut: vi.fn(),
  undo: vi.fn(),
  mark: vi.fn(),
  leave: vi.fn(),
}));
vi.mock("@/lib/auth-client", () => ({ authClient: { signOut: auth.signOut } }));
vi.mock("@/lib/document-identity", () => ({
  markExplicitSignOut: () => {
    auth.mark();
    return auth.undo;
  },
  leaveDocument: auth.leave,
}));

const { signOutAndLeave, signOutFailureKey } = await import("./explicit-sign-out");

beforeEach(() => {
  for (const fn of Object.values(auth)) fn.mockReset();
});

describe("signOutAndLeave", () => {
  it("marks the sign-out, then leaves for the sign-in page on success", async () => {
    auth.signOut.mockImplementation(async (o: { fetchOptions: { onSuccess: () => void } }) => {
      expect(auth.mark).toHaveBeenCalledTimes(1);
      o.fetchOptions.onSuccess();
      return { data: { success: true }, error: null };
    });
    expect(await signOutAndLeave("/en-US/login")).toEqual({ ok: true });
    expect(auth.leave).toHaveBeenCalledWith("/en-US/login");
    expect(auth.undo).not.toHaveBeenCalled();
  });

  it("undoes the mark when the server refuses", async () => {
    const error = { status: 500 };
    auth.signOut.mockResolvedValue({ data: null, error });
    expect(await signOutAndLeave("/en-US/login")).toEqual({ ok: false, error });
    expect(auth.undo).toHaveBeenCalledTimes(1);
    expect(auth.leave).not.toHaveBeenCalled();
  });

  it("undoes the mark when the request throws (offline, transport failure)", async () => {
    const error = new Error("offline");
    auth.signOut.mockRejectedValue(error);
    expect(await signOutAndLeave("/en-US/login")).toEqual({ ok: false, error });
    expect(auth.undo).toHaveBeenCalledTimes(1);
  });
});

describe("sign-out failure copy", () => {
  it("says still signed in and when to retry while offline", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    try {
      const copy = await import("../../../../packages/locales/src/en-US/nav.json");
      expect(signOutFailureKey({ status: 503 })).toBe("userMenu.signOutOffline");
      expect(copy.userMenu.signOutOffline).toBe(
        "You're offline. You're still signed in — sign out again when you're back online.",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("uses offline copy for a network failure and generic copy for a server refusal", () => {
    vi.stubGlobal("navigator", { onLine: true });
    try {
      expect(signOutFailureKey(new TypeError("Failed to fetch"))).toBe("userMenu.signOutOffline");
      expect(signOutFailureKey({ status: 500 })).toBe("userMenu.signOutFailed");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
