import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { parseKbMasterKey, validateKbMasterKeyFormat } from "@knowledge-base/env/kb-master-key";

const ALGORITHM = "aes-256-gcm";
const AAD_DOMAIN = "knowledge-base/at-rest";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const RECORD_VERSION = 1;

export type KbEncryptionPurpose =
  | "sealed-literal"
  | "provider-secret"
  | "share-email"
  | "deploy-key"
  | "query-text"
  | "mirror-key";

export interface KbSecretIdentity {
  aadVersion: number;
  purpose: KbEncryptionPurpose;
  userId: string;
  objectId: string;
  revision: string;
}

export interface KbEncryptedRecord {
  version: typeof RECORD_VERSION;
  algorithm: "AES-256-GCM";
  nonce: string;
  tag: string;
  ciphertext: string;
}

export class KbEncryptionUnavailableError extends Error {
  readonly code = "ENCRYPTION_UNAVAILABLE";

  constructor(message = "At-rest encryption is not configured") {
    super(message);
    this.name = "KbEncryptionUnavailableError";
  }
}

export class KbEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KbEnvelopeError";
  }
}

export {
  kbMasterKeyConfigured,
  validateKbMasterKeyFormat,
} from "@knowledge-base/env/kb-master-key";

export function requireKbMasterKey(value: string | null | undefined): Buffer {
  const parsed = validateKbMasterKeyFormat(value);
  if (!parsed.ok) {
    throw new KbEncryptionUnavailableError(parsed.reason);
  }
  return parsed.bytes;
}

function buildAad(identity: KbSecretIdentity): Buffer {
  if (!Number.isSafeInteger(identity.aadVersion) || identity.aadVersion < 1) {
    throw new KbEnvelopeError("Unsupported envelope AAD version");
  }
  if (!identity.userId || !identity.objectId || !identity.revision) {
    throw new KbEnvelopeError("Envelope identity fields must be non-empty");
  }
  return Buffer.from(
    JSON.stringify([
      AAD_DOMAIN,
      identity.aadVersion,
      identity.purpose,
      identity.userId,
      identity.objectId,
      identity.revision,
    ]),
    "utf8",
  );
}

export function encryptKbSecret(
  plaintext: string | Buffer,
  identity: KbSecretIdentity,
  masterKey: Buffer,
): KbEncryptedRecord {
  if (plaintext.length === 0) throw new KbEnvelopeError("Cannot encrypt an empty secret");
  if (masterKey.byteLength !== 32) throw new KbEnvelopeError("Master key must be 32 bytes");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(buildAad(identity));
  const ciphertext = Buffer.concat([
    typeof plaintext === "string" ? cipher.update(plaintext, "utf8") : cipher.update(plaintext),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    version: RECORD_VERSION,
    algorithm: "AES-256-GCM",
    nonce: nonce.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptKbSecretBytes(
  record: KbEncryptedRecord,
  identity: KbSecretIdentity,
  masterKey: Buffer,
): Buffer {
  if (record.version !== RECORD_VERSION) throw new KbEnvelopeError("Unsupported envelope version");
  if (record.algorithm !== "AES-256-GCM")
    throw new KbEnvelopeError("Unsupported envelope algorithm");
  const nonce = Buffer.from(record.nonce, "base64");
  const tag = Buffer.from(record.tag, "base64");
  const ciphertext = Buffer.from(record.ciphertext, "base64");
  if (nonce.byteLength !== NONCE_BYTES || tag.byteLength !== TAG_BYTES) {
    throw new KbEnvelopeError("Invalid envelope nonce or tag");
  }
  if (masterKey.byteLength !== 32) throw new KbEnvelopeError("Master key must be 32 bytes");
  const decipher = createDecipheriv(ALGORITHM, masterKey, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(buildAad(identity));
  decipher.setAuthTag(tag);
  const plaintext = decipher.update(ciphertext);
  try {
    return Buffer.concat([plaintext, decipher.final()]);
  } finally {
    plaintext.fill(0);
  }
}

export function decryptKbSecret(
  record: KbEncryptedRecord,
  identity: KbSecretIdentity,
  masterKey: Buffer,
): string {
  const bytes = decryptKbSecretBytes(record, identity, masterKey);
  try {
    return bytes.toString("utf8");
  } finally {
    bytes.fill(0);
  }
}

/** Encrypt using KB_MASTER_KEY from the environment string (server/worker only). */
export function encryptKbSecretWithEnvKey(
  plaintext: string,
  identity: KbSecretIdentity,
  masterKeyEnv: string | null | undefined,
): KbEncryptedRecord {
  return encryptKbSecret(plaintext, identity, requireKbMasterKey(masterKeyEnv));
}

export function decryptKbSecretWithEnvKey(
  record: KbEncryptedRecord,
  identity: KbSecretIdentity,
  masterKeyEnv: string | null | undefined,
): string {
  return decryptKbSecret(record, identity, requireKbMasterKey(masterKeyEnv));
}

/** Safe for logs, job payloads, and API projections — never includes plaintext. */
export function redactKbEncryptedRecord(record: KbEncryptedRecord): KbEncryptedRecord {
  return {
    version: record.version,
    algorithm: record.algorithm,
    nonce: record.nonce,
    tag: record.tag,
    ciphertext: record.ciphertext,
  };
}

export function parseKbMasterKeyFromEnv(value: string | null | undefined): Buffer {
  return parseKbMasterKey(value);
}
