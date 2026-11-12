import { randomBytes } from "node:crypto";

/** Application-generated knowledge base ids (cuid2-shaped, 24 chars). */
export function generateKnowledgeBaseId(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(24);
  let out = "";
  for (let i = 0; i < 24; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
  }
  return out;
}
