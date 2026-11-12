import { describe, expect, it } from "vitest";

import { CAS_SNIFF_MIME_TYPES } from "../sniff-mime";
import { UPLOAD_MIME_TYPES } from "./protocol/common";
import { kbWriteToolSchemas } from "./protocol/writes";
import { assertBeginLimits } from "./uploads";

describe("upload begin MIME schema", () => {
  it("advertises exactly the types the server stages (Markdown plus sniffable media)", () => {
    expect([...UPLOAD_MIME_TYPES].sort()).toEqual(
      ["text/markdown", ...CAS_SNIFF_MIME_TYPES].sort(),
    );
  });

  it.each(["image/svg+xml", "text/html", "text/plain", "text/csv", "application/json"])(
    "rejects %s at the schema",
    (mime) => {
      const parsed = kbWriteToolSchemas.knowledge_upload_begin.input.safeParse({
        kbId: "abcdefghijklmnopqrstuvwx",
        idempotencyKey: "key-key-key-key-key",
        kind: "asset",
        size: 1,
        contentHash: `sha256:${"0".repeat(64)}`,
        mime,
      });
      expect(parsed.success).toBe(false);
    },
  );
});

describe("upload begin limits", () => {
  const hash = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

  it("rejects markdown above 2 MiB", () => {
    expect(() =>
      assertBeginLimits({
        kbId: "kb",
        idempotencyKey: "key-key-key-key-key",
        kind: "markdown",
        size: 2 * 1024 * 1024 + 1,
        contentHash: hash,
        mime: "text/markdown",
      }),
    ).toThrow();
  });

  it("rejects asset with text/markdown mime", () => {
    expect(() =>
      assertBeginLimits({
        kbId: "kb",
        idempotencyKey: "key-key-key-key-key",
        kind: "asset",
        size: 100,
        contentHash: hash,
        mime: "text/markdown",
      }),
    ).toThrow();
  });
});
