import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { inspect } from "node:util";
import { decryptKbSecretBytes, encryptKbSecret, type KbSecretIdentity } from "./envelope";
import { KbDomainError } from "./errors";

const ED25519 = "ssh-ed25519";
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const invalidHostKey = () => new KbDomainError("INVALID_ARGUMENT", "Invalid host key");
const unavailable = () => new KbDomainError("STORAGE_UNAVAILABLE", "Deploy key unavailable");

export const MAX_APPROVED_HOST_KEYS = 8;

function sshString(value: Buffer | string): Buffer {
  const bytes = Buffer.from(value);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length);
  return Buffer.concat([len, bytes]);
}

function readSshStrings(blob: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let offset = 0;
  while (offset < blob.length) {
    if (offset + 4 > blob.length) throw invalidHostKey();
    const len = blob.readUInt32BE(offset);
    offset += 4;
    if (len > blob.length - offset) throw invalidHostKey();
    out.push(blob.subarray(offset, offset + len));
    offset += len;
  }
  return out;
}

/** OpenSSH `SHA256:` fingerprint: unpadded base64 of SHA-256 over the key blob. */
export function sshFingerprint(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

function ed25519PublicLine(publicKey: Buffer): string {
  return `${ED25519} ${Buffer.concat([sshString(ED25519), sshString(publicKey)]).toString("base64")}`;
}

/** Owned nonserializable Ed25519 private seed. Borrow synchronously; destroy in finally. */
export class DeployKeySeed {
  #seed: Buffer;
  #destroyed = false;
  private constructor(seed: Buffer) {
    this.#seed = seed;
  }
  static take(seed: Buffer): DeployKeySeed {
    if (seed.length !== 32) {
      seed.fill(0);
      throw unavailable();
    }
    return new DeployKeySeed(seed);
  }
  use<T>(run: (seed: Buffer) => T): T {
    if (this.#destroyed) throw unavailable();
    return run(this.#seed);
  }
  /** Raw 32-byte Ed25519 public key derived from the seed. */
  publicKeyBytes(): Buffer {
    return this.use((seed) => {
      const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
      try {
        const spki = createPublicKey(
          createPrivateKey({ key: der, format: "der", type: "pkcs8" }),
        ).export({ format: "der", type: "spki" });
        return Buffer.from(spki.subarray(spki.length - 32));
      } finally {
        der.fill(0);
      }
    });
  }
  publicKey(): string {
    return ed25519PublicLine(this.publicKeyBytes());
  }
  destroy() {
    this.#seed.fill(0);
    this.#destroyed = true;
  }
  toJSON(): never {
    throw new Error("Deploy key cannot be serialized");
  }
  [inspect.custom]() {
    return "[DeployKeySeed redacted]";
  }
}

export type GeneratedDeployKey = { publicKey: string; fingerprint: string; seed: DeployKeySeed };

export function generateDeployKey(): GeneratedDeployKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" });
  const seed = DeployKeySeed.take(Buffer.from(der.subarray(der.length - 32)));
  der.fill(0);
  const spki = publicKey.export({ format: "der", type: "spki" });
  const pub = spki.subarray(spki.length - 32);
  const blob = Buffer.concat([sshString(ED25519), sshString(pub)]);
  return {
    publicKey: `${ED25519} ${blob.toString("base64")}`,
    fingerprint: sshFingerprint(blob),
    seed,
  };
}

export type DeployKeyIdentity = { kbId: string; remoteVersion: number; keyVersion: number };

function aad(identity: DeployKeyIdentity): KbSecretIdentity {
  if (!Number.isSafeInteger(identity.remoteVersion) || !Number.isSafeInteger(identity.keyVersion))
    throw unavailable();
  return {
    aadVersion: 1,
    purpose: "deploy-key",
    userId: identity.kbId,
    objectId: `remote:${identity.remoteVersion}`,
    revision: `key:${identity.keyVersion}`,
  };
}

export function encryptDeployKey(
  seed: DeployKeySeed,
  identity: DeployKeyIdentity,
  master: Buffer,
): string {
  return seed.use((bytes) => JSON.stringify(encryptKbSecret(bytes, aad(identity), master)));
}

export function decryptDeployKey(
  ciphertext: string,
  identity: DeployKeyIdentity,
  master: Buffer,
): DeployKeySeed {
  try {
    return DeployKeySeed.take(decryptKbSecretBytes(JSON.parse(ciphertext), aad(identity), master));
  } catch {
    throw unavailable();
  }
}

/**
 * Unencrypted `openssh-key-v1` PEM for the worker's private tmpfs key file
 * The caller owns and must zero the returned buffer.
 */
export function renderOpenSshPrivateKey(seed: DeployKeySeed): Buffer {
  const pub = seed.publicKeyBytes();
  const pubBlob = Buffer.concat([sshString(ED25519), sshString(pub)]);
  const check = randomBytes(4);
  const parts: Buffer[] = [];
  try {
    seed.use((bytes) => {
      parts.push(
        check,
        check,
        sshString(ED25519),
        sshString(pub),
        sshString(Buffer.concat([bytes, pub])),
        sshString(""),
      );
    });
    let priv = Buffer.concat(parts);
    const pad = (8 - (priv.length % 8)) % 8;
    priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
    const body = Buffer.concat([
      Buffer.from("openssh-key-v1\0", "latin1"),
      sshString("none"),
      sshString("none"),
      sshString(""),
      Buffer.from([0, 0, 0, 1]),
      sshString(pubBlob),
      sshString(priv),
    ]);
    const b64 = body.toString("base64");
    priv.fill(0);
    body.fill(0);
    const lines = b64.match(/.{1,70}/g) ?? [];
    return Buffer.from(
      `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join("\n")}\n-----END OPENSSH PRIVATE KEY-----\n`,
    );
  } finally {
    for (const part of parts) part.fill(0);
  }
}

export type ApprovedHostKey = { algorithm: string; key: string; fingerprint: string };

const ECDSA_POINT_BYTES: Record<string, number> = {
  "ecdsa-sha2-nistp256": 65,
  "ecdsa-sha2-nistp384": 97,
  "ecdsa-sha2-nistp521": 133,
};

function validateBlob(algorithm: string, blob: Buffer): void {
  const fields = readSshStrings(blob);
  if (fields[0]?.toString("latin1") !== algorithm) throw invalidHostKey();
  if (algorithm === ED25519) {
    if (fields.length !== 2 || fields[1]!.length !== 32) throw invalidHostKey();
    return;
  }
  const point = ECDSA_POINT_BYTES[algorithm];
  if (point !== undefined) {
    if (fields.length !== 3 || fields[1]!.toString("latin1") !== algorithm.slice(11))
      throw invalidHostKey();
    if (fields[2]!.length !== point || fields[2]![0] !== 4) throw invalidHostKey();
    return;
  }
  if (algorithm === "ssh-rsa") {
    // [alg, e, n]; require a >=2048-bit modulus (mpint may carry a leading 0).
    if (fields.length !== 3) throw invalidHostKey();
    const n = fields[2]!;
    const bytes = n[0] === 0 ? n.length - 1 : n.length;
    if (fields[1]!.length === 0 || bytes < 256) throw invalidHostKey();
    return;
  }
  throw invalidHostKey();
}

/**
 * Exact operator-approved host public keys, one `<algorithm> <base64>` entry
 * each. Fingerprints are computed here for independent operator verification;
 * a fingerprint alone is never accepted and nothing is learned on first use.
 */
export function parseApprovedHostKeys(entries: readonly string[]): ApprovedHostKey[] {
  if (entries.length < 1 || entries.length > MAX_APPROVED_HOST_KEYS) throw invalidHostKey();
  const seen = new Set<string>();
  return entries.map((entry) => {
    const match = /^([a-z0-9-]{1,64}) ([A-Za-z0-9+/]{1,8192}={0,2})$/.exec(entry);
    if (!match) throw invalidHostKey();
    const [, algorithm, b64] = match as unknown as [string, string, string];
    const blob = Buffer.from(b64, "base64");
    if (blob.toString("base64") !== b64) throw invalidHostKey();
    validateBlob(algorithm, blob);
    const fingerprint = sshFingerprint(blob);
    if (seen.has(fingerprint)) throw invalidHostKey();
    seen.add(fingerprint);
    return { algorithm, key: `${algorithm} ${b64}`, fingerprint };
  });
}
