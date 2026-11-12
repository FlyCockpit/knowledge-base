import { describe, expect, it } from "vitest";
import { assetValidationContext } from "./asset-authz";
import type { LockQuery } from "./lock";

describe("asset authority catalog", () => {
  it("does not scan the global catalog for an empty manifest", async () => {
    const query: LockQuery = async () => {
      throw new Error("unexpected query");
    };
    const context = await assetValidationContext(query, "target", []);
    expect(context.lineageHashes.size).toBe(0);
    expect(context.trustedBlobs.size).toBe(0);
  });
  it("restricts catalog lookup to KB lineage and the explicit hash inventory", async () => {
    let statement = "";
    let params: unknown;
    const query: LockQuery = async (sql, values) => {
      statement = sql;
      params = values;
      return { rows: [], rowCount: 0 };
    };
    const context = await assetValidationContext(query, "target", ["stolen-hash"]);
    expect(statement).toContain('JOIN "kb_asset_lineage"');
    expect(statement).toContain('l."kbId" = $1');
    expect(params).toEqual(["target", ["stolen-hash"]]);
    expect(context.trustedBlobs.has("stolen-hash")).toBe(false);
  });
});
