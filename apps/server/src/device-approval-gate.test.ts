import { describe, expect, it, vi } from "vitest";
import { guardDeviceApproval } from "./device-approval-gate";

const baseUrl = "https://kb.invalid";
const nonce = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actor = { user: { id: "human" }, session: { id: "session" } };
const request = (path = "/api/auth/device/approve", headers: Record<string, string> = {}) =>
  new Request(baseUrl + path, {
    method: "POST",
    headers: {
      origin: baseUrl,
      "content-type": "application/json",
      "x-device-approval-nonce": nonce,
      ...headers,
    },
    body: JSON.stringify({ userCode: "ABCD1234" }),
  });
function fixture(session: typeof actor | null = actor) {
  const check = vi.fn().mockResolvedValue(undefined);
  return {
    check,
    options: { baseUrl, getSession: vi.fn().mockResolvedValue(session), service: { check } },
  };
}
describe("pre-plugin device gate", () => {
  it("checks persisted intent before approving or denying", async () => {
    for (const decision of ["approve", "deny"] as const) {
      const f = fixture();
      expect(
        await guardDeviceApproval(request(`/api/auth/device/${decision}`), f.options),
      ).toBeNull();
      expect(f.check).toHaveBeenCalledWith(
        { userId: "human", sessionId: "session" },
        { userCode: "ABCD1234", nonce },
        decision,
      );
    }
  });
  it("rejects bearer-only, cross-site, absent nonce and missing selection", async () => {
    const absent = fixture(null);
    expect(
      (
        await guardDeviceApproval(
          request(undefined, { authorization: "Bearer kbp_fake" }),
          absent.options,
        )
      )?.status,
    ).toBe(401);
    expect(absent.options.getSession.mock.calls[0]![0].headers.has("authorization")).toBe(false);
    for (const headers of [
      { origin: "https://evil.invalid" },
      { origin: "" },
      { "x-device-approval-nonce": "" },
    ] as Record<string, string>[]) {
      const f = fixture();
      expect((await guardDeviceApproval(request(undefined, headers), f.options))?.status).toBe(403);
      expect(f.check).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.check.mockRejectedValue(new Error("private detail"));
    const res = await guardDeviceApproval(request(), f.options);
    expect(res?.status).toBe(403);
    expect(await res?.text()).not.toContain("private detail");
  });
  it("blocks the built-in session-token exchange and aliases before handlers", async () => {
    for (const path of [
      "/api/auth/device/token",
      "/api/auth/device/approve/",
      "/api/auth/device/%61pprove",
    ]) {
      expect((await guardDeviceApproval(request(path), fixture().options))?.status).toBe(404);
    }
  });
  it("accepts a configured cross-origin human claim while rejecting foreign navigation", async () => {
    const f = fixture();
    const options = { ...f.options, webOrigin: "https://web.invalid" };
    for (const [origin, status] of [
      ["https://web.invalid", undefined],
      ["https://evil.invalid", 403],
    ] as const) {
      const req = new Request(`${baseUrl}/api/auth/device?user_code=ABCD1234`, {
        headers: { origin, "sec-fetch-site": "cross-site" },
      });
      expect((await guardDeviceApproval(req, options))?.status).toBe(status);
    }
  });
  it("keeps public start accessible and unrelated paths untouched", async () => {
    for (const path of ["/api/auth/device/code", "/api/auth/sign-in/email"])
      expect(await guardDeviceApproval(request(path), fixture(null).options)).toBeNull();
  });
});
