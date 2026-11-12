import { randomBytes, randomUUID } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { decryptKbSecret, encryptKbSecret } from "./envelope";
import {
  decryptSealedRecord,
  encryptSealedRecord,
  SecretLiteral,
  sealedEnrollInput,
  sealedGrantInput,
} from "./sealed-records";

const identity = { namespace: randomUUID(), recordId: randomUUID(), version: 1 };
const canary = "sealed-plaintext-canary-你好";
describe("sealed at-rest identity and input boundaries", () => {
  it("encrypts UTF8, redacts typed buffers, zeroizes disposal and refuses reuse", () => {
    const master = randomBytes(32),
      literal = SecretLiteral.fromUtf8(canary);
    const ciphertext = encryptSealedRecord(literal, identity, master);
    expect(ciphertext).not.toContain(canary);
    expect(inspect(literal)).not.toContain(canary);
    expect(() => JSON.stringify(literal)).toThrow();
    const decoded = decryptSealedRecord(ciphertext, identity, master);
    let borrowed: Buffer | undefined;
    decoded.use((bytes) => {
      borrowed = bytes;
      expect(bytes.toString("utf8")).toBe(canary);
    });
    decoded.destroy();
    expect(borrowed?.every((b) => b === 0)).toBe(true);
    expect(() => decoded.use(() => {})).toThrow();
    literal.destroy();
  });
  it("authenticates purpose, namespace, record and immutable version; wrong key and tampering fail", () => {
    const master = randomBytes(32),
      literal = SecretLiteral.fromUtf8(canary);
    const cipher = encryptSealedRecord(literal, identity, master);
    for (const changed of [
      { ...identity, namespace: randomUUID() },
      { ...identity, recordId: randomUUID() },
      { ...identity, version: 2 },
    ])
      expect(() => decryptSealedRecord(cipher, changed, master)).toThrow();
    expect(() => decryptSealedRecord(cipher, identity, randomBytes(32))).toThrow();
    const aad = {
      aadVersion: 1,
      purpose: "provider-secret" as const,
      userId: identity.namespace,
      objectId: identity.recordId,
      revision: "1",
    };
    expect(() => decryptKbSecret(JSON.parse(cipher), aad, master)).toThrow();
    expect(() =>
      decryptSealedRecord(JSON.stringify(encryptKbSecret(canary, aad, master)), identity, master),
    ).toThrow();
    const changed = JSON.parse(cipher);
    changed.tag = randomBytes(16).toString("base64");
    expect(() => decryptSealedRecord(JSON.stringify(changed), identity, master)).toThrow();
    literal.destroy();
  });
  it("enforces 16KiB by UTF8 bytes, rejects empty/malformed text and closed schemas", () => {
    const input = {
      kbId: "a".repeat(24),
      namespace: identity.namespace,
      plaintext: "😀".repeat(4096),
      idempotencyKey: randomUUID(),
    };
    expect(sealedEnrollInput.safeParse(input).success).toBe(true);
    for (const plaintext of ["", "😀".repeat(4097), "\ud800"])
      expect(sealedEnrollInput.safeParse({ ...input, plaintext }).success).toBe(false);
    expect(sealedEnrollInput.safeParse({ ...input, authorizerId: "other" }).success).toBe(false);
    expect(() => SecretLiteral.fromUtf8("😀".repeat(4097))).toThrow();
    expect(
      sealedGrantInput.safeParse({
        kbId: input.kbId,
        reference: "*",
        consumerId: "*",
        idempotencyKey: input.idempotencyKey,
      }).success,
    ).toBe(false);
  });
});
