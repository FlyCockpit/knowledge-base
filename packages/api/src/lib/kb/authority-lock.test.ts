import { describe, expect, it } from "vitest";
import { runLockedOperation } from "./authority-lock";

describe("locked operation shape", () => {
  it("rejects malformed KB ids before any gate or connection is acquired", async () => {
    await expect(
      runLockedOperation({
        connectionString: "postgresql://127.0.0.1:1/kb_test_none",
        opId: "invalid_kb",
        kind: "kb-write",
        kbIds: ["invalid/id"],
        async run() {
          throw new Error("must not run");
        },
      }),
    ).rejects.toMatchObject({ code: "LOCK_ORDER", message: "invalid knowledge-base id" });
  });

  it("rejects a kb-write without knowledge-base ids", async () => {
    await expect(
      runLockedOperation({
        connectionString: "postgresql://127.0.0.1:1/kb_test_none",
        opId: "op_empty",
        kind: "kb-write",
        async run() {
          return "no";
        },
      }),
    ).rejects.toMatchObject({ code: "LOCK_ORDER" });
  });

  it("rejects knowledge-base ids on an authority-only mutation", async () => {
    await expect(
      runLockedOperation({
        connectionString: "postgresql://127.0.0.1:1/kb_test_none",
        opId: "op_auth_kb",
        kind: "authority",
        kbIds: ["kb1"],
        async run() {
          return "no";
        },
      }),
    ).rejects.toMatchObject({ code: "LOCK_ORDER" });
  });
});
