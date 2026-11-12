/**
 * KB_MASTER_KEY helpers — validation without ever logging the key material.
 * Shared by server, worker, doctor, and container entrypoint checks.
 */

const MASTER_KEY_BYTE_LENGTH = 32;

export function kbMasterKeyConfigured(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export type KbMasterKeyValidation = { ok: true; bytes: Buffer } | { ok: false; reason: string };

/** Parse and validate format. Never includes the supplied value in `reason`. */
export function validateKbMasterKeyFormat(value: string | null | undefined): KbMasterKeyValidation {
  if (!kbMasterKeyConfigured(value)) {
    return { ok: false, reason: "KB_MASTER_KEY is not set" };
  }
  const trimmed = value!.trim();
  let decoded: Buffer;
  try {
    decoded = Buffer.from(trimmed, "base64");
  } catch {
    return { ok: false, reason: "KB_MASTER_KEY must be valid base64" };
  }
  if (decoded.length !== MASTER_KEY_BYTE_LENGTH) {
    return {
      ok: false,
      reason: `KB_MASTER_KEY must decode to exactly ${MASTER_KEY_BYTE_LENGTH} bytes`,
    };
  }
  const canonical = decoded.toString("base64");
  if (canonical.replace(/=+$/u, "") !== trimmed.replace(/=+$/u, "")) {
    return { ok: false, reason: "KB_MASTER_KEY must be canonical base64 of 32 bytes" };
  }
  return { ok: true, bytes: decoded };
}

export function parseKbMasterKey(value: string | null | undefined): Buffer {
  const result = validateKbMasterKeyFormat(value);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.bytes;
}
