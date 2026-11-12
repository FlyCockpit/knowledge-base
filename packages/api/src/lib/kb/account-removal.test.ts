import { describe, expect, it } from "vitest";

import {
  AccountDeletionBlockedError,
  listAccountTeardownHandlersForTests,
  mapAccountDeletionError,
} from "./account-removal";

describe("account removal registry", () => {
  it("exposes teardown handlers for future providers and jobs", () => {
    expect(listAccountTeardownHandlersForTests().length).toBeGreaterThanOrEqual(1);
  });

  it("maps blocked deletion to domain conflict", () => {
    const mapped = mapAccountDeletionError(new AccountDeletionBlockedError());
    expect(mapped?.code).toBe("CONFLICT");
  });
});
