import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sealedApprovalExpirySchema, sealedRecipientPublicKey } from "./sealed-recipient";

describe("shared sealed recipient policy", () => {
  it("accepts a generated X25519 key and rejects zero, nonzero low-order and noncanonical encodings", () => {
    const key = generateKeyPairSync("x25519").publicKey;
    const encoded = key.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    expect(sealedRecipientPublicKey(encoded).equals(key)).toBe(true);
    const lowOrder = Buffer.alloc(32);
    lowOrder[0] = 1;
    for (const value of [
      Buffer.alloc(32).toString("base64"),
      lowOrder.toString("base64"),
      encoded.slice(0, -1),
      `${encoded.slice(0, -2)}B=`,
    ])
      expect(() => sealedRecipientPublicKey(value)).toThrow("Invalid sealed recipient key");
  });
  it("preserves UTC seconds and millisecond instants, rejecting finer or malformed input before conversion", () => {
    const second = "2026-10-09T01:02:03";
    for (const fraction of ["", ".1", ".12", ".123"])
      expect(sealedApprovalExpirySchema.parse(`${second}${fraction}Z`)).toBe(
        `${second}${fraction}Z`,
      );
    for (const value of [
      `${second}.1236Z`,
      `${second}.123600000Z`,
      `${second}.123000000Z`,
      `${second}.123+00:00`,
      "2026-02-30T01:02:03.123Z",
      "2026-10-09T01:02Z",
    ])
      expect(sealedApprovalExpirySchema.safeParse(value).success).toBe(false);
  });
});
