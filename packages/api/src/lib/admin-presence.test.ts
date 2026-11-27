import { describe, expect, it, vi } from "vitest";
import { assertAdminRemovalAllowed, mapUserChangeConflict } from "./admin-presence";
import type { LockQuery } from "./kb/lock";

function query(target: Record<string, unknown> | null, count = 1) {
  return vi.fn<LockQuery>().mockImplementation(async <R>(sql: string) => ({
    rows: (sql.includes("count(*)") ? [{ count }] : target ? [target] : []) as R[],
    rowCount: 1,
  }));
}
const admin = {
  id: "a",
  role: "user, Admin",
  emailVerified: true,
  banned: false,
  banExpires: null,
};

describe("last active verified admin guard", () => {
  it.each([undefined, "user"])("blocks removing the last admin (next role %s)", async (role) => {
    await expect(assertAdminRemovalAllowed(query(admin), "a", role)).rejects.toMatchObject({
      code: "FORBIDDEN",
      data: { reason: "LAST_ACTIVE_ADMIN" },
    });
  });
  it("allows removing one of two active admins and counts exact role tokens, verification and expired bans", async () => {
    const sql = query(admin, 2);
    await expect(assertAdminRemovalAllowed(sql, "a", "user")).resolves.toEqual(admin);
    const countSql = sql.mock.calls[1]?.[0] ?? "";
    expect(countSql).toContain("string_to_array");
    expect(countSql).toContain("^\\s*admin\\s*$");
    expect(countSql).toContain('"emailVerified" IS TRUE');
    expect(countSql).toContain('"banExpires" <= now()');
    expect(countSql).toContain("ORDER BY u.id FOR UPDATE OF u");
  });
  it.each([
    { ...admin, role: "user" },
    { ...admin, emailVerified: false },
    { ...admin, banned: true },
  ])("ignores targets who are not usable admins: %j", async (target) => {
    const sql = query(target);
    await assertAdminRemovalAllowed(sql, "a");
    expect(sql).toHaveBeenCalledOnce();
  });
  it("still protects an admin whose temporary ban expired", async () => {
    await expect(
      assertAdminRemovalAllowed(query({ ...admin, banned: true, banExpires: new Date(0) }), "a"),
    ).rejects.toMatchObject({ data: { reason: "LAST_ACTIVE_ADMIN" } });
  });
  it("allows promotion without counting and reports missing targets", async () => {
    const sql = query(admin);
    await assertAdminRemovalAllowed(sql, "a", "admin");
    expect(sql).toHaveBeenCalledOnce();
    await expect(assertAdminRemovalAllowed(query(null), "missing")).rejects.toMatchObject({
      data: { reason: "USER_NOT_FOUND" },
    });
  });
  it.each(["P2034", "40001"])("maps %s to a retryable conflict", (code) => {
    expect(() => mapUserChangeConflict({ code })).toThrow(
      expect.objectContaining({ code: "CONFLICT", data: { reason: "USER_CHANGE_CONFLICT" } }),
    );
  });
  it("propagates a stale snapshot failure while locking the eligible admins", async () => {
    const sql = query(admin, 2);
    const conflict = Object.assign(new Error("concurrent admin removal"), { code: "40001" });
    sql.mockImplementationOnce(async <R>() => ({ rows: [admin] as R[], rowCount: 1 }));
    sql.mockRejectedValueOnce(conflict);
    await expect(assertAdminRemovalAllowed(sql, "a")).rejects.toBe(conflict);
  });
});
