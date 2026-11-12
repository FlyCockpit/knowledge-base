import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptKbSecret,
  encryptKbSecret,
  type KbEncryptedRecord,
  KbEncryptionUnavailableError,
  type KbSecretIdentity,
  redactKbEncryptedRecord,
  requireKbMasterKey,
} from "./envelope.js";

const CANARY = "canary-plaintext-do-not-leak-xyzzy";
const masterKey = randomBytes(32);
const identity: KbSecretIdentity = {
  aadVersion: 1,
  purpose: "provider-secret",
  userId: "user-1",
  objectId: "provider-rev-9",
  revision: "3",
};

describe("kb envelope encryption", () => {
  it("round-trips plaintext", () => {
    const record = encryptKbSecret(CANARY, identity, masterKey);
    expect(decryptKbSecret(record, identity, masterKey)).toBe(CANARY);
  });

  it("uses unique nonces for identical plaintext", () => {
    const first = encryptKbSecret(CANARY, identity, masterKey);
    const second = encryptKbSecret(CANARY, identity, masterKey);
    expect(first.nonce).not.toBe(second.nonce);
  });

  it.each([
    ["purpose", { ...identity, purpose: "share-email" as const }],
    ["userId", { ...identity, userId: "other-user" }],
    ["objectId", { ...identity, objectId: "other-object" }],
    ["revision", { ...identity, revision: "99" }],
    ["aadVersion", { ...identity, aadVersion: 2 }],
  ])("rejects %s substitution", (_field, changed) => {
    const record = encryptKbSecret(CANARY, identity, masterKey);
    expect(() => decryptKbSecret(record, changed, masterKey)).toThrow();
  });

  it("rejects master key substitution", () => {
    const record = encryptKbSecret(CANARY, identity, masterKey);
    const otherKey = randomBytes(32);
    expect(() => decryptKbSecret(record, identity, otherKey)).toThrow();
  });

  it("rejects tag tampering", () => {
    const record = encryptKbSecret(CANARY, identity, masterKey);
    const tag = Buffer.from(record.tag, "base64");
    tag[0] ^= 1;
    const tampered: KbEncryptedRecord = { ...record, tag: tag.toString("base64") };
    expect(() => decryptKbSecret(tampered, identity, masterKey)).toThrow();
  });

  it("never embeds plaintext in serialized or redacted records", () => {
    const record = encryptKbSecret(CANARY, identity, masterKey);
    const serialized = JSON.stringify(record);
    const redacted = JSON.stringify(redactKbEncryptedRecord(record));
    expect(serialized).not.toContain(CANARY);
    expect(redacted).not.toContain(CANARY);
    expect(serialized).not.toContain("xyzzy");
  });

  it("fails closed when the master key env value is missing", () => {
    expect(() => requireKbMasterKey(undefined)).toThrow(KbEncryptionUnavailableError);
    expect(() => requireKbMasterKey("")).toThrow(KbEncryptionUnavailableError);
  });
});
