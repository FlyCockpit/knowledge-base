import { describe, expect, it } from "vitest";
import { CAS_BLOB_MAX_BYTES, STAGED_MARKDOWN_UPLOAD_MAX_BYTES } from "./limits";
import {
  UPLOAD_CALLS_PER_MAX_SAVE,
  UPLOAD_FRAME_HTTP_POINTS,
  UPLOAD_PROCEDURE_POINTS,
} from "./upload-budget";
import { UPLOAD_MAX_CHUNK_BYTES } from "./uploads";

describe("upload budgets", () => {
  it("fit one maximal editor save, from the limits the server enforces", () => {
    const frames = (bytes: number) => Math.ceil(bytes / UPLOAD_MAX_CHUNK_BYTES);
    expect(UPLOAD_CALLS_PER_MAX_SAVE).toBe(
      frames(CAS_BLOB_MAX_BYTES) + frames(STAGED_MARKDOWN_UPLOAD_MAX_BYTES) + 4,
    );
    expect(UPLOAD_PROCEDURE_POINTS).toBeGreaterThan(UPLOAD_CALLS_PER_MAX_SAVE);
    // The typed procedure refusal (with retryAfterSeconds) comes before the HTTP one.
    expect(UPLOAD_FRAME_HTTP_POINTS).toBeGreaterThan(UPLOAD_PROCEDURE_POINTS);
  });
});
