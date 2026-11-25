import { credentialEnded, KbAdmissionError } from "@knowledge-base/api/lib/kb/principal";
import { describe, expect, it, vi } from "vitest";
import { createKbTokenRoutes } from "./kb-token-routes";

describe("narrow PAT self-revoke route", () => {
  it("accepts no body, requires PAT, charges every attempt and revokes only the admitted generation", async () => {
    const revoke = vi.fn(async () => {});
    const charge = vi.fn(async () => {});
    const admit = vi.fn(async () => ({
      principal: {
        kind: "token" as const,
        userId: "u",
        grantId: "g",
        grantGeneration: "g",
        scopes: ["mcp:read"],
        expiresAt: new Date("2099-01-01"),
        storedAcl: new Map(),
        credential: {
          kind: "PAT" as const,
          tokenId: "t",
          clientId: "pat:t",
          resource: "https://kb.example.invalid/mcp",
        },
      },
      verifier: { inspect: vi.fn() },
      recheck: vi.fn(),
      demandToolGroups: vi.fn(),
      demandAuthoring: vi.fn(),
    }));
    const app = createKbTokenRoutes({ admit, revoke, charge, isClosing: () => false });
    const call = (body?: string) =>
      app.request("/api/kb/token/revoke-self", {
        method: "POST",
        headers: { authorization: "Bearer fixture" },
        body,
      });
    expect((await call("{}")).status).toBe(400);
    expect(revoke).not.toHaveBeenCalled();
    expect((await call()).status).toBe(204);
    expect(admit).toHaveBeenCalledWith(expect.any(Request), { selfRevoke: true });
    expect(revoke).toHaveBeenCalledExactlyOnceWith("u", "t");
    // A suspended credential: the plain refusal (the client keeps it).
    admit.mockRejectedValueOnce(new KbAdmissionError("UNAUTHORIZED", "denied"));
    const suspended = await call();
    expect(suspended.status).toBe(401);
    expect(await suspended.json()).toEqual({ error: "UNAUTHORIZED" });
    expect(suspended.headers.has("www-authenticate")).toBe(false);
    // An ended credential (unknown, revoked, expired) says so, so logout drops it.
    admit.mockRejectedValueOnce(credentialEnded());
    const ended = await call();
    expect(ended.status).toBe(401);
    expect(await ended.json()).toEqual({ error: "UNAUTHORIZED", credential: "ended" });
    expect(ended.headers.get("cache-control")).toBe("no-store");
    expect(ended.headers.has("www-authenticate")).toBe(false);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(charge).toHaveBeenCalledTimes(4);
  });
  it("shutdown prevents both admission and revocation", async () => {
    const admit = vi.fn();
    const revoke = vi.fn();
    const app = createKbTokenRoutes({
      admit,
      revoke,
      charge: async () => {},
      isClosing: () => true,
    });
    expect((await app.request("/api/kb/token/revoke-self", { method: "POST" })).status).toBe(503);
    expect(admit).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });
});
