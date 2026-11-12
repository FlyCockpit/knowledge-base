import {
  createCipheriv,
  createHash,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { sealedRecipientPublicKey } from "@knowledge-base/auth/sealed-recipient";
import type { z } from "zod";
import { KbDomainError } from "./errors";
import { uuidSchema } from "./protocol/common";
import { kbReadToolSchemas } from "./protocol/reads";
import type { SecretLiteral } from "./sealed-records";
import { parseSealedReference } from "./sealed-reference";

const invalid = () => new KbDomainError("UNRESOLVED_REFERENCE", "Unresolved reference");
type Result = z.infer<typeof kbReadToolSchemas.knowledge_sealed_resolve.output>;

/** Synchronous borrow only: no plaintext string, retained literal, cache or recipient decrypt API.
 * Native KeyObject owns the ephemeral private key; it is never exported/serialized. */
export function createRecipientEnvelope(
  literal: SecretLiteral,
  binding: {
    reference: string;
    recipientKeyId: string;
    recipientPublicKey: string;
    expiresAt: string;
  },
): Result {
  let shared: Buffer | undefined;
  let key: Buffer | undefined;
  try {
    const { reference, recipientKeyId, expiresAt } = binding;
    parseSealedReference(reference);
    uuidSchema.parse(recipientKeyId);
    const ttl = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 60_000) throw invalid();
    const recipient = sealedRecipientPublicKey(binding.recipientPublicKey);
    const ephemeral = generateKeyPairSync("x25519");
    shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
    if (shared.length !== 32 || shared.every((byte) => byte === 0)) throw invalid();
    key = Buffer.from(
      hkdfSync(
        "sha256",
        shared,
        createHash("sha256").update(reference, "utf8").digest(),
        Buffer.from(`kb/sealed/1\0${recipientKeyId}\0${expiresAt}`, "utf8"),
        32,
      ),
    );
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(`${reference}\0${recipientKeyId}\0${expiresAt}`, "utf8"));
    const ciphertext = literal.use((bytes) =>
      Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()]),
    );
    return kbReadToolSchemas.knowledge_sealed_resolve.output.parse({
      reference,
      recipientKeyId,
      expiresAt,
      envelope: {
        algorithm: "X25519-HKDF-SHA256-AES256GCM",
        ephemeralPublicKey: ephemeral.publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64"),
        nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      },
    });
  } catch {
    throw invalid();
  } finally {
    key?.fill(0);
    shared?.fill(0);
  }
}
