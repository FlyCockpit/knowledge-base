import { describe, expect, it } from "vitest";

import {
  listTransferLifecycleHandlersForTests,
  registerTransferLifecycleHandler,
} from "./transfer";

describe("transfer lifecycle registry", () => {
  it("registers explicit stub handlers", () => {
    const before = listTransferLifecycleHandlersForTests().length;
    registerTransferLifecycleHandler(async () => {});
    expect(listTransferLifecycleHandlersForTests().length).toBe(before + 1);
  });

  it("includes default provider and mirror stubs", () => {
    expect(listTransferLifecycleHandlersForTests().length).toBeGreaterThanOrEqual(2);
  });
});
