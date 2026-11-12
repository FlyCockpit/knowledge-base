import { describe, expect, it, vi } from "vitest";
import {
  embedQuery,
  prepareEmbeddingQuery,
  redactForEmbed,
  SEALED_EMBED_MARKER,
} from "./redact-for-embed";

const reference =
  "{{sealed:v1:knowledge_base:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222}}";
describe("embedding redaction", () => {
  it("preserves empty/default prose and replaces symbolic references without resolution", () => {
    expect(redactForEmbed("")).toBe("");
    expect(redactForEmbed("ordinary text")).toBe("ordinary text");
    expect(redactForEmbed(`${reference} and ${reference}`)).toBe(
      `${SEALED_EMBED_MARKER} and ${SEALED_EMBED_MARKER}`,
    );
  });
  it.each([
    "sk-fixture-canary-1234567890",
    "Authorization: Bearer fixture-canary-1234567890",
    "-----BEGIN EC PRIVATE KEY-----\ncanary\n-----END EC PRIVATE KEY-----",
  ])("rejects sensitive queries before any embedder call: %#", async (canary) => {
    const embed = vi.fn();
    expect(redactForEmbed(canary)).toBeNull();
    for (let i = 0; i < 2; i++) {
      try {
        await embedQuery({ embed }, canary);
        throw new Error("must reject");
      } catch (error) {
        expect(error).toMatchObject({
          code: "SENSITIVE_QUERY",
          message: "Sensitive query rejected",
        });
        expect(String(error)).not.toContain(canary);
      }
    }
    expect(embed).not.toHaveBeenCalled();
  });
  it("passes only the redacted query and cancellation signal to the embedder", async () => {
    const embed = vi.fn().mockResolvedValue([[1, 0]]);
    const signal = new AbortController().signal;
    expect(await embedQuery({ embed }, reference, signal)).toEqual([[1, 0]]);
    expect(embed).toHaveBeenCalledWith([SEALED_EMBED_MARKER], { purpose: "query", signal });
    expect(prepareEmbeddingQuery("normal query")).toBe("normal query");
  });
});
