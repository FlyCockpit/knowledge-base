import { beforeEach, describe, expect, it, vi } from "vitest";

const links = vi.hoisted(() => ({
  deleteResetLinksOnActivation: vi.fn(async (_userId: string) => {}),
}));
vi.mock("./password-reset-links.js", () => ({
  deleteResetLinksOnActivation: links.deleteResetLinksOnActivation,
}));

const { afterAccountCreate, afterUserUpdate, noteVerificationWrite } = await import(
  "./account-activation"
);

beforeEach(() => vi.clearAllMocks());

describe("account activation deletes leftover reset links", () => {
  it("after a write that verified the email", async () => {
    const context = {};
    noteVerificationWrite({ emailVerified: true }, context);
    await afterUserUpdate({ id: "u1", emailVerified: true }, context);
    expect(links.deleteResetLinksOnActivation).toHaveBeenCalledWith("u1");
  });

  it("not after an unrelated update of a verified user, nor an unverify", async () => {
    const context = {};
    noteVerificationWrite({ name: "Ada" }, context);
    await afterUserUpdate({ id: "u1", emailVerified: true }, context);
    const unverify = {};
    noteVerificationWrite({ emailVerified: false }, unverify);
    await afterUserUpdate({ id: "u1", emailVerified: false }, unverify);
    expect(links.deleteResetLinksOnActivation).not.toHaveBeenCalled();
  });

  it("whenever the row is verified when there is no endpoint context (fail safe)", async () => {
    await afterUserUpdate({ id: "u1", emailVerified: true }, null);
    expect(links.deleteResetLinksOnActivation).toHaveBeenCalledWith("u1");
  });

  it("after an IdP identity is linked, not after a credential account", async () => {
    await afterAccountCreate({ userId: "u1", providerId: "credential" });
    expect(links.deleteResetLinksOnActivation).not.toHaveBeenCalled();
    await afterAccountCreate({ userId: "u1", providerId: "sso" });
    expect(links.deleteResetLinksOnActivation).toHaveBeenCalledWith("u1");
  });
});
