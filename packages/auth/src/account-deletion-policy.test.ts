import { describe, expect, it } from "vitest";

import {
  getAllowedAccountDeletionMode,
  isAdminForceAccountDeletion,
  runWithAllowedAccountDeletion,
} from "./account-deletion-policy";

describe("account-deletion-policy", () => {
  it("defaults to undefined outside a scoped run", () => {
    expect(getAllowedAccountDeletionMode()).toBeUndefined();
    expect(isAdminForceAccountDeletion()).toBe(false);
  });

  it("runs nested work under admin-force mode", async () => {
    await runWithAllowedAccountDeletion("admin-force", async () => {
      expect(getAllowedAccountDeletionMode()).toBe("admin-force");
      expect(isAdminForceAccountDeletion()).toBe(true);
    });
    expect(getAllowedAccountDeletionMode()).toBeUndefined();
  });
});
