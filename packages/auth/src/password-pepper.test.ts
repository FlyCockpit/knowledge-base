import { createCipheriv, hkdfSync } from "node:crypto";

import { hashPassword } from "better-auth/crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { createPasswordPepper, pepperFingerprint } from "./password-pepper";

const OLD = "disposable-old-unit-test-key-0123456789";
const NEW = "disposable-new-unit-test-key-9876543210";
const PASSWORD = "unit-test-password-12345";
const old = createPasswordPepper({ secret: OLD });
const current = createPasswordPepper({ secret: NEW });
const rotating = createPasswordPepper({ secret: NEW, previousSecret: OLD });
let legacy: string;
let stored: string;

beforeAll(async () => {
  legacy = await hashPassword(PASSWORD);
  stored = await old.hash(PASSWORD);
});

describe("createPasswordPepper", () => {
  it("hashes in the sealed format and verifies only the right password", async () => {
    expect(old.isAuthentic(stored)).toBe(true);
    expect(rotating.isAuthentic(stored)).toBe(true);
    expect(current.isAuthentic(stored)).toBe(false);
    expect(old.isAuthentic(legacy)).toBe(false);
    expect(stored).toMatch(/^pw1:[0-9a-f]{16}:[A-Za-z0-9_-]+$/);
    expect(await old.verify({ hash: stored, password: PASSWORD })).toBe(true);
    expect(await old.verify({ hash: stored, password: "wrong" })).toBe(false);
  });

  it("has a stable, domain-separated key fingerprint", () => {
    expect(old.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(pepperFingerprint(OLD)).toBe(old.fingerprint);
    expect(createPasswordPepper({ secret: OLD }).fingerprint).toBe(old.fingerprint);
    expect(current.fingerprint).not.toBe(old.fingerprint);
    expect(old.previousFingerprint).toBeNull();
    expect(rotating.previousFingerprint).toBe(old.fingerprint);
  });

  it("uses a fresh nonce even when re-sealing the same inner hash", async () => {
    const first = current.reseal(legacy);
    const second = current.reseal(legacy);
    expect(first).not.toBe(second);
    expect(first?.split(":")[2]?.slice(0, 16)).not.toBe(second?.split(":")[2]?.slice(0, 16));
    expect(await old.hash(PASSWORD)).not.toBe(stored);
  });

  it("never verifies unsealed legacy hashes", async () => {
    expect(old.classify(legacy)).toBe("legacy");
    expect(await old.verify({ hash: legacy, password: PASSWORD })).toBe(false);
  });

  it.each(["nonce", "ciphertext", "tag", "fingerprint", "prefix"])(
    "rejects a tampered %s",
    async (part) => {
      const [prefix, fingerprint, payload = ""] = stored.split(":");
      const bytes = Buffer.from(payload, "base64url");
      const offset = part === "nonce" ? 0 : part === "ciphertext" ? 12 : bytes.length - 1;
      bytes[offset] = (bytes[offset] ?? 0) ^ 1;
      const tampered =
        part === "prefix"
          ? stored.replace("pw1:", "pw2:")
          : part === "fingerprint"
            ? stored.replace(old.fingerprint, current.fingerprint)
            : `${prefix}:${fingerprint}:${bytes.toString("base64url")}`;
      expect(old.isAuthentic(tampered)).toBe(false);
      expect(await old.verify({ hash: tampered, password: PASSWORD })).toBe(false);
    },
  );

  it("rejects another key and classifies it as unknown", async () => {
    expect(current.classify(stored)).toBe("unknown-key");
    expect(await current.verify({ hash: stored, password: PASSWORD })).toBe(false);
  });

  it("verifies the previous key and re-wraps without needing the password", async () => {
    expect(rotating.classify(stored)).toBe("previous");
    expect(await rotating.verify({ hash: stored, password: PASSWORD })).toBe(true);
    const next = rotating.reseal(stored);
    expect(next).not.toBeNull();
    expect(current.classify(next ?? "")).toBe("current");
    expect(await current.verify({ hash: next ?? "", password: PASSWORD })).toBe(true);
  });

  it("seals legacy hashes under the current key", async () => {
    const next = rotating.reseal(legacy);
    expect(next).not.toBeNull();
    expect(await current.verify({ hash: next ?? "", password: PASSWORD })).toBe(true);
  });

  it("does not re-seal current, unknown, malformed, or unauthentic previous values", () => {
    expect(old.classify(stored)).toBe("current");
    expect(old.reseal(stored)).toBeNull();
    expect(current.reseal(stored)).toBeNull();
    for (const value of ["", "broken", "pw2:bad:payload"]) {
      expect(old.classify(value)).toBe("malformed");
      expect(old.reseal(value)).toBeNull();
    }
    expect(rotating.reseal(`pw1:${old.fingerprint}:!`)).toBeNull();
    expect(rotating.reseal(`pw1:${old.fingerprint}:a`)).toBeNull();
    expect(rotating.reseal(`pw1:${old.fingerprint}:${"A".repeat(100)}`)).toBeNull();
  });

  it.each([
    "empty payload",
    "nonce and tag only",
    "non-base64url",
    "padding",
    "uppercase fingerprint",
    "15-hex fingerprint",
    "17-hex fingerprint",
    "four segments",
  ])("rejects the envelope boundary: %s", async (boundary) => {
    const [prefix, fingerprint = "", payload = ""] = stored.split(":");
    const invalid: Record<string, string> = {
      "empty payload": `${prefix}:${fingerprint}:`,
      "nonce and tag only": `${prefix}:${fingerprint}:${Buffer.alloc(12 + 16).toString("base64url")}`,
      "non-base64url": `${prefix}:${fingerprint}:!${payload}`,
      padding: `${stored}=`,
      "uppercase fingerprint": `${prefix}:${fingerprint.toUpperCase()}:${payload}`,
      "15-hex fingerprint": `${prefix}:${fingerprint.slice(0, 15)}:${payload}`,
      "17-hex fingerprint": `${prefix}:${fingerprint}0:${payload}`,
      "four segments": `${stored}:extra`,
    };
    const hash = invalid[boundary] ?? "";
    expect(old.isAuthentic(hash)).toBe(false);
    expect(await old.verify({ hash, password: PASSWORD })).toBe(false);
  });

  it("rejects authentic GCM ciphertext whose inner value is not a scrypt hash", async () => {
    const nonce = Buffer.alloc(12);
    const key = Buffer.from(
      hkdfSync("sha256", OLD, Buffer.alloc(0), "flycockpit password pepper v1", 32),
    );
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from("password-v1"));
    const payload = Buffer.concat([
      nonce,
      cipher.update("not a password hash"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const hash = `pw1:${old.fingerprint}:${payload.toString("base64url")}`;
    expect(old.isAuthentic(hash)).toBe(false);
    expect(await old.verify({ hash, password: PASSWORD })).toBe(false);
    expect(rotating.reseal(hash)).toBeNull();
  });

  it("refuses identical current and previous secrets", () => {
    expect(() => createPasswordPepper({ secret: OLD, previousSecret: OLD })).toThrow(
      /equals BETTER_AUTH_SECRET/,
    );
    expect(() => createPasswordPepper({ secret: "" })).toThrow(/is empty/);
  });
});
