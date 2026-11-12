import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { bindBearerAdmission } from "./context";

it("keeps bearer admission separate from browser sessions and oRPC control context", () => {
  const source = readFileSync(new URL("./context.ts", import.meta.url), "utf8");
  expect(source).not.toMatch(/session:|createContext|accessToken:/);
});

it("a derived admission's recheck enforces its own tool-group demands; the base is unaffected", async () => {
  let toolGroups = ["read", "kb_admin"];
  const inspect = async () => ({
    generationActive: true,
    instanceEnabled: true,
    expired: false,
    banned: false,
    twoFactorSatisfied: true,
    toolGroups,
  });
  const base = bindBearerAdmission(
    {
      kind: "token",
      userId: "u",
      grantId: "g",
      grantGeneration: "g",
      scopes: ["mcp:write"],
      expiresAt: null,
      storedAcl: new Map(),
    },
    { inspect },
  );
  const scoped = base.demandToolGroups(["kb_admin"]);
  expect(scoped.principal.toolGroupDemands).toEqual([["kb_admin"]]);
  expect(base.principal.toolGroupDemands).toBeUndefined();
  await expect(scoped.recheck()).resolves.toMatchObject({ toolGroups });
  toolGroups = ["read"];
  await expect(scoped.recheck()).rejects.toMatchObject({ code: "FORBIDDEN" });
  await expect(base.recheck()).resolves.toBeDefined();
  await expect(scoped.demandToolGroups([]).recheck()).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});
