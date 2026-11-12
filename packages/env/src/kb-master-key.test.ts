import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kbMasterKeyConfigured, validateKbMasterKeyFormat } from "./kb-master-key.js";

describe("KB_MASTER_KEY validation", () => {
  it("accepts canonical base64 of 32 bytes", () => {
    const value = randomBytes(32).toString("base64");
    const result = validateKbMasterKeyFormat(value);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.byteLength).toBe(32);
  });

  it("rejects missing, short, and non-base64 values without echoing secrets", () => {
    const secret = randomBytes(32).toString("base64");
    for (const value of [
      undefined,
      "",
      "not-valid-base64!!!",
      Buffer.alloc(16).toString("base64"),
    ]) {
      const result = validateKbMasterKeyFormat(value);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain(secret);
      }
    }
  });

  it("is generated via secret32b64 in the env manifest", () => {
    const manifest = readFileSync(
      join(import.meta.dirname, "../../../scripts/lib/env-manifest.ts"),
      "utf8",
    );
    expect(manifest).toMatch(/key: "KB_MASTER_KEY"/);
    expect(manifest).toMatch(/generator: "secret32b64"/);
  });

  it("detects configured vs unset without returning key material", () => {
    expect(kbMasterKeyConfigured(undefined)).toBe(false);
    expect(kbMasterKeyConfigured("   ")).toBe(false);
    expect(kbMasterKeyConfigured(randomBytes(32).toString("base64"))).toBe(true);
  });
});
