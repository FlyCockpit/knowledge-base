/**
 * Standalone KB_MASTER_KEY shape check for Docker entrypoints (no workspace TS imports).
 * Keep in sync with packages/env/src/kb-master-key.ts — kb-master-key.test.ts asserts parity.
 */

import { fileURLToPath } from "node:url";

const MASTER_KEY_BYTE_LENGTH = 32;

export function validateKbMasterKeyFormat(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: "KB_MASTER_KEY is not set" };
  }
  const trimmed = value.trim();
  let decoded;
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

function main() {
  const result = validateKbMasterKeyFormat(process.env.KB_MASTER_KEY);
  if (!result.ok) {
    console.error(`FATAL: ${result.reason}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
