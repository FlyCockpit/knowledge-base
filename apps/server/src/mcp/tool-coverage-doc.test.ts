import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { assertAuditCoverage } from "@knowledge-base/api/lib/kb/audit-map";
import { describe, expect, it } from "vitest";
import { assertCoverage, generateCoverage, inventoryRouterLeaves } from "./tool-coverage-doc";

const root = resolve(import.meta.dirname, "../../../..");
describe("MCP coverage inventory", () => {
  it("classifies every current oRPC leaf and renders the checked-in coverage", () => {
    const leaves = inventoryRouterLeaves(root);
    expect(leaves).toContain("kbs.list");
    expect(leaves).toContain("mcpTokens.create");
    expect(() => assertCoverage(leaves)).not.toThrow();
    expect(generateCoverage(leaves)).toBe(
      readFileSync(resolve(root, "docs/mcp-tool-coverage.md"), "utf8"),
    );
  });
  it("fails a newly introduced unclassified handler and stale exclusion", () => {
    const leaves = inventoryRouterLeaves(root);
    expect(() => assertCoverage([...leaves, "kbs.accidentalGateway"])).toThrow();
    expect(() => assertCoverage(leaves.filter((leaf) => leaf !== "kbs.list"))).toThrow();
  });
  it("maps every actual oRPC leaf to an audit event or an explicit read-only/out-of-band class", () => {
    const leaves = inventoryRouterLeaves(root);
    expect(() => assertAuditCoverage({ rpcLeaves: leaves })).not.toThrow();
    expect(() =>
      assertAuditCoverage({ rpcLeaves: [...leaves, "kbs.unclassifiedMutation"] }),
    ).toThrow(/unclassified/i);
  });
  it("rejects a new unmounted handler rather than silently excluding it", () => {
    const scratch = mkdtempSync(resolve(tmpdir(), "kb-tool-inventory-"));
    try {
      const routers = resolve(scratch, "packages/api/src/routers");
      cpSync(resolve(root, "packages/api/src/routers"), routers, { recursive: true });
      writeFileSync(
        resolve(routers, "unclassified.ts"),
        "export const unclassified = { secret: protectedProcedure.handler(() => 1) };\n",
      );
      expect(() => inventoryRouterLeaves(scratch)).toThrow();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
