import { describe, expect, it } from "vitest";

import { acceptRequestId, awaitsInvitationAccept } from "./kb-links";

const ID = "11111111-1111-4111-8111-111111111111";

describe("invitation acceptance links", () => {
  it("accepts only a request id", () => {
    expect(acceptRequestId(ID)).toBe(ID);
    expect(acceptRequestId("not-an-id")).toBeUndefined();
    expect(acceptRequestId(42)).toBeUndefined();
  });

  it("defers the KB read only on settings opened from an invitation", () => {
    expect(awaitsInvitationAccept(true, ID)).toBe(true);
    expect(awaitsInvitationAccept(true, undefined)).toBe(false);
    expect(awaitsInvitationAccept(true, "junk")).toBe(false);
    expect(awaitsInvitationAccept(false, ID)).toBe(false);
  });
});
