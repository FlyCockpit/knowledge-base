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

const { signOutAndLeave } = await import("./explicit-sign-out");

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
