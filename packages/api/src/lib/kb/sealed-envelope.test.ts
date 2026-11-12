import * as crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import vector from "./fixtures/sealed.json";
import { kbReadToolSchemas } from "./protocol/reads";
import { createRecipientEnvelope } from "./sealed-envelope";
import { SecretLiteral } from "./sealed-records";

vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof crypto>();
  return {
    ...actual,
    generateKeyPairSync: vi.fn(actual.generateKeyPairSync),
    randomBytes: vi.fn(actual.randomBytes),
    diffieHellman: vi.fn(actual.diffieHellman),
  };
});
afterEach(() => vi.restoreAllMocks());
const rawPrivate = (hex: string) =>
  crypto.createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b656e04220420", "hex"),
      Buffer.from(hex, "hex"),
    ]),
    format: "der",
    type: "pkcs8",
  });
const rawPublic = (base64: string) =>
  crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b656e032100", "hex"),
      Buffer.from(base64, "base64"),
    ]),
    format: "der",
    type: "spki",
  });
const binding = () => ({ ...vector.result, recipientPublicKey: vector.recipientPublicKey });

// Test-only recipient: the server/agent transport must never expose this operation.
function receive(raw: unknown, privateKey = rawPrivate(vector.recipientPrivateKey)) {
  const result = kbReadToolSchemas.knowledge_sealed_resolve.output.parse(raw);
  const ttl = Date.parse(result.expiresAt) - Date.now();
  if (ttl <= 0 || ttl > 60_000) throw new Error("expiry");
  const shared = crypto.diffieHellman({
    privateKey,
    publicKey: rawPublic(result.envelope.ephemeralPublicKey),
  });
  if (shared.every((byte) => byte === 0)) throw new Error("zero shared secret");
  const salt = crypto.createHash("sha256").update(result.reference).digest();
  const info = Buffer.from(`kb/sealed/1\0${result.recipientKeyId}\0${result.expiresAt}`);
  const key = Buffer.from(crypto.hkdfSync("sha256", shared, salt, info, 32));
  const bytes = Buffer.from(result.envelope.ciphertext, "base64");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(result.envelope.nonce, "base64"),
  );
  decipher.setAAD(
    Buffer.from(`${result.reference}\0${result.recipientKeyId}\0${result.expiresAt}`),
  );
  decipher.setAuthTag(bytes.subarray(-16));
  try {
    return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString(
      "utf8",
    );
  } finally {
    key.fill(0);
    shared.fill(0);
  }
}
function frozenTime() {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-15T12:00:00.000Z"));
}

describe("sealed recipient wire cryptography", () => {
  it("matches the shared deterministic X25519/HKDF/AAD/base64 vector exactly", () => {
    frozenTime();
    const privateKey = rawPrivate(vector.ephemeralPrivateKey);
    const ephemeral = { privateKey, publicKey: crypto.createPublicKey(privateKey) };
    // The shared recipient validator generates a validation pair before the
    // envelope generates its wire pair. Neither changes the normative vector.
    vi.mocked(crypto.generateKeyPairSync)
      .mockReturnValueOnce(ephemeral)
      .mockReturnValueOnce(ephemeral);
    vi.mocked(crypto.randomBytes).mockReturnValueOnce(
      Buffer.from(vector.result.envelope.nonce, "base64"),
    );
    const literal = SecretLiteral.fromUtf8(vector.plaintext);
    try {
      expect(createRecipientEnvelope(literal, binding())).toEqual(vector.result);
    } finally {
      literal.destroy();
    }
    const shared = crypto.diffieHellman({
      privateKey,
      publicKey: rawPublic(vector.recipientPublicKey),
    });
    expect(shared.toString("hex")).toBe(vector.sharedSecretHex);
    expect(crypto.createHash("sha256").update(vector.result.reference).digest("hex")).toBe(
      vector.saltHex,
    );
    expect(
      Buffer.from(
        `kb/sealed/1\0${vector.result.recipientKeyId}\0${vector.result.expiresAt}`,
      ).toString("hex"),
    ).toBe(vector.infoHex);
    expect(
      Buffer.from(
        `${vector.result.reference}\0${vector.result.recipientKeyId}\0${vector.result.expiresAt}`,
      ).toString("hex"),
    ).toBe(vector.aadHex);
    expect(
      Buffer.from(
        crypto.hkdfSync(
          "sha256",
          shared,
          Buffer.from(vector.saltHex, "hex"),
          Buffer.from(vector.infoHex, "hex"),
          32,
        ),
      ).toString("hex"),
    ).toBe(vector.aesKeyHex);
    expect(receive(vector.result)).toBe(vector.plaintext);
  });
  it("authenticates reference, key ID, expiry, nonce, ciphertext and recipient", () => {
    frozenTime();
    for (const changed of [
      {
        ...vector.result,
        reference: vector.result.reference.replace("000000000002", "000000000004"),
      },
      { ...vector.result, recipientKeyId: "00000000-0000-4000-8000-000000000004" },
      { ...vector.result, expiresAt: "2026-01-15T12:00:59.000Z" },
      ...["nonce", "ciphertext"].map((field) => {
        const envelope = { ...vector.result.envelope };
        const bytes = Buffer.from(
          field === "nonce" ? envelope.nonce : envelope.ciphertext,
          "base64",
        );
        bytes[0] = bytes[0]! ^ 1;
        return { ...vector.result, envelope: { ...envelope, [field]: bytes.toString("base64") } };
      }),
    ])
      expect(() => receive(changed)).toThrow();
    expect(() => receive(vector.result, rawPrivate("03".repeat(32)))).toThrow();
  });
  it("rejects malformed or zero keys, zero shared secret, malformed wire sizes/base64 and overlong/expired lifetime", () => {
    frozenTime();
    const literal = SecretLiteral.fromUtf8("x");
    try {
      for (const recipientPublicKey of [
        "",
        "!".repeat(44),
        Buffer.alloc(31).toString("base64"),
        Buffer.alloc(33).toString("base64"),
        Buffer.alloc(32).toString("base64"),
        `${vector.recipientPublicKey}\n`,
      ])
        expect(() =>
          createRecipientEnvelope(literal, { ...binding(), recipientPublicKey }),
        ).toThrow();
      const zero = Buffer.alloc(32);
      vi.mocked(crypto.diffieHellman).mockReturnValueOnce(zero);
      expect(() => createRecipientEnvelope(literal, binding())).toThrow();
      for (const expiresAt of ["2026-01-15T12:01:00.001Z", "2026-01-15T12:00:00.000Z", "invalid"])
        expect(() => createRecipientEnvelope(literal, { ...binding(), expiresAt })).toThrow();
    } finally {
      literal.destroy();
    }
    for (const envelope of [
      { ...vector.result.envelope, ephemeralPublicKey: Buffer.alloc(32).toString("base64") },
      ...["ephemeralPublicKey", "nonce", "ciphertext"].flatMap((field) =>
        ["!", "", "YQ==", "YQ==\n"].map((value) => ({ ...vector.result.envelope, [field]: value })),
      ),
      { ...vector.result.envelope, salt: "unexpected" },
    ])
      expect(() => receive({ ...vector.result, envelope })).toThrow();
    expect(() => receive({ ...vector.result, expiresAt: "2026-01-15T12:01:00.001Z" })).toThrow();
    expect(() => receive({ ...vector.result, expiresAt: "2026-01-15T12:00:00.000Z" })).toThrow();
  });
  it("uses fresh ephemeral keys/nonces without caching and wipes the borrowed shared secret", () => {
    frozenTime();
    const shared = Buffer.alloc(32, 7);
    const validationShared = Buffer.alloc(32, 7);
    const literal = SecretLiteral.fromUtf8(vector.plaintext);
    try {
      const first = createRecipientEnvelope(literal, binding());
      const second = createRecipientEnvelope(literal, binding());
      expect(first.envelope.ephemeralPublicKey).not.toBe(second.envelope.ephemeralPublicKey);
      expect(first.envelope.nonce).not.toBe(second.envelope.nonce);
      expect(receive(first)).toBe(vector.plaintext);
      expect(receive(second)).toBe(vector.plaintext);
      vi.mocked(crypto.diffieHellman)
        .mockReturnValueOnce(validationShared)
        .mockReturnValueOnce(shared);
      createRecipientEnvelope(literal, binding());
      expect(validationShared.every((byte) => byte === 0)).toBe(true);
      expect(shared.every((byte) => byte === 0)).toBe(true);
    } finally {
      literal.destroy();
    }
  });
});
