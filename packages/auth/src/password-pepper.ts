/**
 * Password pepper: every stored password hash is Better-Auth's own scrypt hash
 * (`better-auth/crypto`), sealed with AES-256-GCM under a key derived from
 * BETTER_AUTH_SECRET. A database dump alone (backup, replica, SQL injection
 * read) then yields no offline-crackable hash: the attacker also needs the
 * server's secret. docs/hosting.md § Password pepper.
 *
 * Stored format: `pw1:<key fingerprint>:<base64url(nonce || ciphertext || tag)>`.
 *   - key         = HKDF-SHA256(BETTER_AUTH_SECRET, salt "", info "flycockpit password pepper v1"), 32 bytes
 *   - fingerprint = hex(HKDF-SHA256(BETTER_AUTH_SECRET, salt "", info "flycockpit pepper id"), 8 bytes);
 *                   non-secret, names the key a value was sealed under
 *   - AAD         = "password-v1". Better-Auth's `password.hash`/`password.verify`
 *                   hooks receive only the password (and the stored hash), never a
 *                   user or account id, so the seal cannot be bound to its row.
 *                   Swapping two rows' sealed values is equivalent to swapping
 *                   their plain hashes, which a database writer could do anyway.
 *
 * Verification picks the key by fingerprint from {current, previous}
 * (BETTER_AUTH_SECRET_PREVIOUS during a rotation). Anything that is not a
 * well-formed `pw1` value under a configured key fails verification: an
 * unsealed hash is accepted only by the one-time startup conversion
 * (./password-pepper-store.ts), never by sign-in.
 *
 * Side-effect free and env-free: callers pass the secrets in.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import { hashPassword, verifyPassword } from "better-auth/crypto";

export const PEPPER_PREFIX = "pw1";
const KEY_INFO = "flycockpit password pepper v1";
const FINGERPRINT_INFO = "flycockpit pepper id";
const AAD = Buffer.from("password-v1", "utf8");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
/** Better-Auth's default scrypt encoding: 16-byte hex salt, 64-byte hex key. */
const SCRYPT_HASH_PATTERN = /^[0-9a-f]{32}:[0-9a-f]{128}$/;

type PepperKey = { readonly fingerprint: string; readonly key: Buffer };

function hkdf(secret: string, info: string, length: number): Buffer {
  return Buffer.from(
    hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), info, length),
  );
}

/** The non-secret id of the pepper key derived from `secret` (16 hex chars). */
export function pepperFingerprint(secret: string): string {
  return hkdf(secret, FINGERPRINT_INFO, 8).toString("hex");
}

function deriveKey(secret: string): PepperKey {
  return { fingerprint: pepperFingerprint(secret), key: hkdf(secret, KEY_INFO, 32) };
}

/** True for a hash in Better-Auth's default (unsealed) scrypt format. */
export function isLegacyScryptHash(value: string): boolean {
  return SCRYPT_HASH_PATTERN.test(value);
}

/** The fingerprint a sealed value names, or null when it is not a `pw1` value. */
export function sealedFingerprint(value: string): string | null {
  const parts = value.split(":");
  if (parts.length !== 3 || parts[0] !== PEPPER_PREFIX) return null;
  const [, fingerprint] = parts;
  return fingerprint && FINGERPRINT_PATTERN.test(fingerprint) ? fingerprint : null;
}

export type StoredPasswordKind =
  /** Sealed under the current key. */
  | "current"
  /** Sealed under BETTER_AUTH_SECRET_PREVIOUS: re-seal at startup. */
  | "previous"
  /** Better-Auth's plain scrypt hash from before the pepper: seal at startup. */
  | "legacy"
  /** Sealed under a key that is not configured: refuse to start. */
  | "unknown-key"
  /** A pw1 value with an invalid envelope. */
  | "corrupt"
  /** Neither: never verifies; left alone and reported. */
  | "malformed";

export type PasswordPepper = {
  /** Fingerprint of the current key (BETTER_AUTH_SECRET). */
  readonly fingerprint: string;
  /** Fingerprint of BETTER_AUTH_SECRET_PREVIOUS, when set. */
  readonly previousFingerprint: string | null;
  /** `emailAndPassword.password.hash`. */
  hash(password: string): Promise<string>;
  /** `emailAndPassword.password.verify`. */
  verify(data: { hash: string; password: string }): Promise<boolean>;
  /** True only for an authentic envelope containing a Better-Auth scrypt hash. */
  isAuthentic(stored: string): boolean;
  classify(stored: string): StoredPasswordKind;
  /**
   * Seal a legacy hash, or re-seal a previous-key value, under the current key.
   * Null for anything else (already current, unknown key, malformed, or a
   * previous-key value that fails authentication).
   */
  reseal(stored: string): string | null;
};

export type PasswordPepperSecrets = {
  /** BETTER_AUTH_SECRET. */
  secret: string;
  /** BETTER_AUTH_SECRET_PREVIOUS, during a rotation. */
  previousSecret?: string | undefined;
};

export function createPasswordPepper({
  secret,
  previousSecret,
}: PasswordPepperSecrets): PasswordPepper {
  if (!secret) throw new Error("password pepper: BETTER_AUTH_SECRET is empty");
  const current = deriveKey(secret);
  const previous = previousSecret ? deriveKey(previousSecret) : null;
  if (previous && previous.fingerprint === current.fingerprint) {
    throw new Error(
      "password pepper: BETTER_AUTH_SECRET_PREVIOUS equals BETTER_AUTH_SECRET; unset it or set the old secret",
    );
  }

  function keyFor(fingerprint: string): PepperKey | null {
    if (fingerprint === current.fingerprint) return current;
    if (previous && fingerprint === previous.fingerprint) return previous;
    return null;
  }

  function seal(innerHash: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", current.key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(AAD);
    const body = Buffer.concat([
      cipher.update(innerHash, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return `${PEPPER_PREFIX}:${current.fingerprint}:${Buffer.concat([nonce, body]).toString("base64url")}`;
  }

  /** The inner scrypt hash, or null when the value is not authentic under a configured key. */
  function open(stored: string): string | null {
    const fingerprint = sealedFingerprint(stored);
    if (!fingerprint) return null;
    const key = keyFor(fingerprint);
    if (!key) return null;
    const payload = stored.slice(PEPPER_PREFIX.length + 1 + fingerprint.length + 1);
    if (!BASE64URL_PATTERN.test(payload)) return null;
    const raw = Buffer.from(payload, "base64url");
    if (raw.length <= NONCE_BYTES + TAG_BYTES) return null;
    const nonce = raw.subarray(0, NONCE_BYTES);
    const tag = raw.subarray(raw.length - TAG_BYTES);
    const ciphertext = raw.subarray(NONCE_BYTES, raw.length - TAG_BYTES);
    try {
      const decipher = createDecipheriv("aes-256-gcm", key.key, nonce, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      const inner = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      return isLegacyScryptHash(inner) ? inner : null;
    } catch {
      return null;
    }
  }

  return {
    fingerprint: current.fingerprint,
    previousFingerprint: previous?.fingerprint ?? null,

    isAuthentic(stored) {
      return open(stored) !== null;
    },

    async hash(password) {
      return seal(await hashPassword(password));
    },

    async verify({ hash, password }) {
      const inner = open(hash);
      if (inner === null) {
        // Keep the failure as slow as a wrong password, so a corrupt or
        // foreign value is no faster-to-probe oracle than a real one.
        await hashPassword(password);
        return false;
      }
      return verifyPassword({ hash: inner, password });
    },

    classify(stored) {
      const fingerprint = sealedFingerprint(stored);
      if (fingerprint === null) {
        if (stored.startsWith(`${PEPPER_PREFIX}:`)) return "corrupt";
        return isLegacyScryptHash(stored) ? "legacy" : "malformed";
      }
      if (fingerprint === current.fingerprint) return "current";
      if (previous && fingerprint === previous.fingerprint) return "previous";
      return "unknown-key";
    },

    reseal(stored) {
      const fingerprint = sealedFingerprint(stored);
      if (fingerprint === null) return isLegacyScryptHash(stored) ? seal(stored) : null;
      if (!previous || fingerprint !== previous.fingerprint) return null;
      const inner = open(stored);
      return inner === null ? null : seal(inner);
    },
  };
}

/** Thrown at startup when stored values name a key no configured secret provides. */
export class PasswordPepperKeyError extends Error {
  constructor(
    readonly count: number,
    readonly fingerprints: readonly string[],
    readonly configured: readonly string[],
  ) {
    super(
      `password pepper: ${count} stored password hash(es) are sealed under key ` +
        `${fingerprints.join(", ")}, but the configured BETTER_AUTH_SECRET is key ` +
        `${configured.join(" (previous: ")}${configured.length > 1 ? ")" : ""}. ` +
        "Refusing to start, because every one of those users could not sign in. " +
        "Restore the BETTER_AUTH_SECRET these were written with (set it as " +
        "BETTER_AUTH_SECRET, or as BETTER_AUTH_SECRET_PREVIOUS while rotating). " +
        "If that secret is lost, those passwords must be reset with " +
        "`pnpm auth:pepper:reset-unusable` while the server is stopped: see " +
        "docs/hosting.md § Password pepper.",
    );
    this.name = "PasswordPepperKeyError";
  }
}
