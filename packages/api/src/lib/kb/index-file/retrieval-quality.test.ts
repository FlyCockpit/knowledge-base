import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type RetrievalScore,
  replayDocumentVector,
  replayQueryVector,
  retrievalCorpus,
  scoreRetrieval,
} from "./testing";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "kb-retrieval-"));
  dirs.push(dir);
  return dir;
};
const expectAtLeast = (score: RetrievalScore, lane: keyof typeof retrievalCorpus.thresholds) => {
  const t = retrievalCorpus.thresholds[lane];
  expect(
    {
      semanticHit1: score.semanticHit1 >= t.semanticHit1,
      semanticHit3: score.semanticHit3 >= t.semanticHit3,
      keywordHit1: score.keywordHit1 >= t.keywordHit1,
    },
    JSON.stringify(score, null, 2),
  ).toEqual({ semanticHit1: true, semanticHit3: true, keywordHit1: true });
};

// (CLI twin `tests/retrieval_quality.rs`; real-model lane in gemma-model.integration.test.ts).
describe("retrieval quality on the shared corpus", () => {
  it("hybrid: the recorded Gemma vector ranking fused with the real lexical arm keeps semantic hits first", async () => {
    const dimensions = Object.keys(retrievalCorpus.documents).length;
    const score = await scoreRetrieval(tempDir(), {
      dimensions,
      document: async (path) => replayDocumentVector(path),
      query: async (query) => replayQueryVector(query),
    });
    expectAtLeast(score, "replay");
  });

  it("lexical-only: keyword queries rank their note first", async () => {
    expectAtLeast(await scoreRetrieval(tempDir(), null), "lexical");
  });
});
