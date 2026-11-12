import { createPublicKey, diffieHellman, generateKeyPairSync } from "node:crypto";
import { z } from "zod";

/** PostgreSQL timestamptz(3) and JavaScript Date preserve these instants exactly.
 * Reject finer input spellings before any selection/approval write, never round authority up. */
export const sealedApprovalExpirySchema = z.iso
  .datetime()
  .max(24)
  .regex(/T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/);

/** One recipient rule for direct approvals, device selection/revalidation and envelopes.
 * A canonical nonzero encoding alone does not reject low-order X25519 points. */
export function sealedRecipientPublicKey(value: string) {
  let shared: Buffer | undefined;
  try {
    if (value.length !== 44) throw new Error();
    const bytes = Buffer.from(value, "base64");
    if (bytes.length !== 32 || bytes.toString("base64") !== value) throw new Error();
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), bytes]),
      format: "der",
      type: "spki",
    });
    shared = diffieHellman({
      privateKey: generateKeyPairSync("x25519").privateKey,
      publicKey,
    });
    if (shared.length !== 32 || shared.every((b) => b === 0)) throw new Error();
    return publicKey;
  } catch {
    throw new Error("Invalid sealed recipient key");
  } finally {
    shared?.fill(0);
  }
}
