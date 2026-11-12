import { describe, expect, it } from "vitest";
import { isQueryAccessError } from "./query-access-error";

describe("query access errors", () => {
  it.each([401, 403, 404])("hides cached content on HTTP %s", (status) => {
    expect(isQueryAccessError({ status })).toBe(true);
  });
  it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])(
    "recognizes nested %s domain failures",
    (code) => {
      expect(isQueryAccessError({ code: "INTERNAL_SERVER_ERROR", data: { code } })).toBe(true);
    },
  );
  it.each([null, undefined, new Error("offline"), { status: 500 }, { code: "TOO_MANY_REQUESTS" }])(
    "permits retained content on a transient failure: %s",
    (error) => {
      expect(isQueryAccessError(error)).toBe(false);
    },
  );
});
