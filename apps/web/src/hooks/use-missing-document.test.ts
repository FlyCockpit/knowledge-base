import { describe, expect, it } from "vitest";
import { missingDocumentState } from "./use-missing-document";

describe("missing document memory", () => {
  it("keeps a missing answer during its refetch, and clears it on success or target change", () => {
    const missing = missingDocumentState(null, "a", "missing");
    expect(missing.missing).toBe(true);
    expect(missingDocumentState(missing.key, "a", "fetching").missing).toBe(true);
    expect(missingDocumentState(missing.key, "b", "fetching").missing).toBe(false);
    expect(missingDocumentState(missing.key, "a", "error").missing).toBe(false);
    const success = missingDocumentState(missing.key, "a", "success");
    expect(success.missing).toBe(false);
    expect(missingDocumentState(success.key, "a", "fetching").missing).toBe(false);
  });
});
