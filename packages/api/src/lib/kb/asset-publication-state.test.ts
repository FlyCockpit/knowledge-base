import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type AssetStorageRecord, createAssetPublicationState } from "./asset-publication-state";
import type { LockQuery } from "./lock";

function fixture() {
  const binding = { storageGeneration: randomUUID(), locator: "s3:fixture" };
  const record: AssetStorageRecord = {
    version: 1,
    mode: "s3",
    activeGeneration: binding.storageGeneration,
    locator: binding.locator,
  };
  const authority = {
    active: record,
    control: false,
    pending: [] as {
      attemptId: string;
      state: string;
      targetMode: string;
      targetGeneration: string;
      targetLocator: string;
    }[],
  };
  const retained = new Map<string, { size: number; state: string }>();
  const statements: string[] = [];
  const key = (v: unknown[]) => JSON.stringify(v.slice(0, 3));
  const query: LockQuery = async <R>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number | null }> => {
    statements.push(sql);
    let rows: unknown[] = [];
    if (sql.includes("FROM app_setting")) rows = [{ value: JSON.stringify(authority.active) }];
    else if (sql.includes("to_regclass"))
      rows = [{ relation: authority.control ? "control" : null }];
    else if (sql.includes("FROM knowledge_base_control")) rows = authority.pending;
    else if (sql.startsWith("INSERT")) {
      const k = key(values);
      if (!retained.has(k)) retained.set(k, { size: Number(values[3]), state: "PENDING" });
    } else if (sql.startsWith("SELECT size")) {
      const r = retained.get(key(values));
      if (r) rows = [r];
    } else if (sql.startsWith("UPDATE")) {
      retained.get(key(values))!.state = "DURABLE";
    }
    return { rows: rows as R[], rowCount: rows.length };
  };
  const transactions = async <T>(_deadline: number, work: (q: LockQuery) => Promise<T>) =>
    work(query);
  return { binding, record, authority, retained, statements, transactions };
}
const hash = `sha256:${"a".repeat(64)}`;
describe("asset remote retained intents", () => {
  it("creates before PUT, validates size, and marks only the exact active obligation durable", async () => {
    const f = fixture(),
      state = createAssetPublicationState(f);
    await state.pending(hash, 10, Date.now() + 1000);
    expect([...f.retained.values()]).toEqual([{ size: 10, state: "PENDING" }]);
    await expect(state.pending(hash, 11, Date.now() + 1000)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    await state.durable(hash, 10, Date.now() + 1000);
    expect([...f.retained.values()]).toEqual([{ size: 10, state: "DURABLE" }]);
    expect(
      f.statements.every((sql) => !sql.includes("asset_blob") && !sql.includes("lineage")),
    ).toBe(true);
  });
  it("does not accept a historical generation or pending control transition as runtime authority", async () => {
    const f = fixture(),
      state = createAssetPublicationState(f);
    f.authority.active = { ...f.record, activeGeneration: randomUUID() };
    await expect(state.pending(hash, 10, 1)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    expect(f.retained.size).toBe(0);
    f.authority.active = f.record;
    f.authority.control = true;
    f.authority.pending = [
      {
        attemptId: randomUUID(),
        state: "COPYING",
        targetMode: "s3",
        targetGeneration: f.binding.storageGeneration,
        targetLocator: f.binding.locator,
      },
    ];
    await expect(state.pending(hash, 10, 1)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
  it("requires a matching pending offline control attempt and both fences at every write", async () => {
    const f = fixture(),
      attemptId = randomUUID();
    let fenced = true;
    const state = createAssetPublicationState({
      ...f,
      offline: {
        attemptId,
        assertOfflineFences() {
          if (!fenced) throw new Error("not fenced");
        },
      },
    });
    await expect(state.pending(hash, 10, 1)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
    f.authority.control = true;
    f.authority.pending = [
      {
        attemptId,
        state: "COPYING",
        targetMode: "s3",
        targetGeneration: f.binding.storageGeneration,
        targetLocator: f.binding.locator,
      },
    ];
    await state.pending(hash, 10, 1);
    fenced = false;
    await expect(state.durable(hash, 10, 1)).rejects.toThrow("not fenced");
    expect([...f.retained.values()][0]?.state).toBe("PENDING");
    fenced = true;
    f.authority.pending[0]!.attemptId = randomUUID();
    await expect(state.durable(hash, 10, 1)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
  });
});
