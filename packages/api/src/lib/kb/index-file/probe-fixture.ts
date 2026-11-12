/**
 * Reader-pool start probe fixture: a format-1 index file (binary_int8_rescore, 8 dims, one
 * document with the chunk "index probe"), built by the real writer and stored gzip + base64 so
 * the server can probe a file open without ever reaching the writer. `writer.test.ts` checks
 * that it still opens, probes and matches the rendered DDL.
 */
import type { ExpectedIndexMeta } from "./reader";

export const PROBE_EXPECTED: ExpectedIndexMeta = {
  generationId: "probegenprobegenprobegen",
  kbId: "probekbprobekbprobekbpro",
  commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  fingerprint: "fp-test",
  dimensions: 8,
  chunkCount: 1,
  documentCount: 1,
};

export const PROBE_FTS_TERM = "probe";

export const PROBE_INDEX_GZIP_BASE64 = [
  "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",
].join("");
