import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@knowledge-base/db", () => ({ default: {} }));
vi.mock("@knowledge-base/env/shared", () => ({ env: {} }));
vi.mock("@knowledge-base/api/lib/kb/jobs", async (original) => ({
  ...(await original<object>()),
  claimJobAttempt: vi.fn(),
}));
vi.mock("@knowledge-base/api/lib/kb/job-attempt", () => ({
  withJobAttempt: vi.fn(async (_j, _o, run) => run()),
}));
vi.mock("@knowledge-base/api/lib/kb/embedder", () => ({
  createProviderEmbedder: vi.fn(),
}));
vi.mock("@knowledge-base/api/lib/kb/query-embedding", () => ({
  dispatchQueryEmbedding: vi.fn(),
  completeQueryEmbedding: vi.fn(),
  failQueryEmbedding: vi.fn(async () => {}),
}));

import { createProviderEmbedder } from "@knowledge-base/api/lib/kb/embedder";
import { claimJobAttempt } from "@knowledge-base/api/lib/kb/jobs";
import {
  completeQueryEmbedding,
  dispatchQueryEmbedding,
  failQueryEmbedding,
} from "@knowledge-base/api/lib/kb/query-embedding";
import type { PrismaClient } from "@knowledge-base/db/client";
import { handleQueryEmbeddingJob, runQueryEmbeddingDelivery } from "./query-embedding";

const options = {
  connectionString: "fixture",
  masterKey: undefined,
  workerId: "worker",
  durableJobId: "00000000-0000-4000-8000-000000000001",
};
const db = {} as PrismaClient;
function claimed() {
  vi.mocked(claimJobAttempt).mockResolvedValue({
    id: options.durableJobId,
    kind: "QUERY_EMBEDDING",
    workerOwner: "worker",
    attemptEpoch: 2,
  } as never);
}
afterEach(() => vi.resetAllMocks());
describe("query worker", () => {
  it("rejects credentials/text/overrides in Redis and ignores duplicate delivery", async () => {
    expect(() =>
      handleQueryEmbeddingJob({
        data: { durableJobId: options.durableJobId, query: "private" },
      } as never),
    ).toThrow();
    expect(claimJobAttempt).not.toHaveBeenCalled();
    vi.mocked(claimJobAttempt).mockResolvedValue(null);
    const embed = vi.fn();
    expect(await runQueryEmbeddingDelivery(db, { ...options, embedder: { embed } })).toEqual({
      skipped: true,
    });
    expect(embed).not.toHaveBeenCalled();
  });
  it("uses query purpose and dispatch guard, returns only the accepted marker", async () => {
    claimed();
    vi.mocked(dispatchQueryEmbedding).mockResolvedValue({
      text: "query",
      deadline: new Date(Date.now() + 10_000),
    } as never);
    vi.mocked(completeQueryEmbedding).mockResolvedValue({ accepted: true });
    const embed = vi.fn(async (_t, o) => {
      await o.beforeDispatch();
      return [[3, 4]];
    });
    expect(await runQueryEmbeddingDelivery(db, { ...options, embedder: { embed } })).toEqual({
      accepted: true,
    });
    expect(embed).toHaveBeenCalledWith(
      ["query"],
      expect.objectContaining({ purpose: "query", signal: expect.any(AbortSignal) }),
    );
    expect(dispatchQueryEmbedding).toHaveBeenCalledTimes(2);
    expect(completeQueryEmbedding).toHaveBeenCalledWith(
      expect.objectContaining(options),
      { jobId: options.durableJobId, workerId: "worker", epoch: 2 },
      [[3, 4]],
    );
  });
  it("shutdown prevents dispatch and private provider errors never reach Redis", async () => {
    claimed();
    const controller = new AbortController();
    controller.abort();
    const embed = vi.fn();
    await expect(
      runQueryEmbeddingDelivery(db, { ...options, signal: controller.signal, embedder: { embed } }),
    ).rejects.toThrow("Query embedding unavailable");
    expect(embed).not.toHaveBeenCalled();
    expect(dispatchQueryEmbedding).not.toHaveBeenCalled();
    expect(failQueryEmbedding).toHaveBeenCalled();
    vi.mocked(dispatchQueryEmbedding).mockResolvedValue({
      text: "query",
      deadline: new Date(Date.now() + 10_000),
    } as never);
    embed.mockRejectedValue(new Error("private key and query"));
    await expect(
      runQueryEmbeddingDelivery(db, { ...options, embedder: { embed } }),
    ).rejects.toThrow(/^Query embedding unavailable$/);
    expect(completeQueryEmbedding).not.toHaveBeenCalled();
  });
});

describe("query worker adapter routing", () => {
  const pin = (kind: "OPENAI_COMPAT" | "SYSTEM_BUILTIN") =>
    ({
      text: "query",
      deadline: new Date(Date.now() + 10_000),
      kind,
      providerId: "p".repeat(24),
      revision: 1,
      ownerId: kind === "SYSTEM_BUILTIN" ? null : "owner",
    }) as never;

  it("a SYSTEM_BUILTIN pin embeds through the worker's Qwen child, never the OpenAI adapter", async () => {
    claimed();
    vi.mocked(dispatchQueryEmbedding).mockResolvedValue(pin("SYSTEM_BUILTIN"));
    vi.mocked(completeQueryEmbedding).mockResolvedValue({ accepted: true });
    const embed = vi.fn(async () => [[1, 0]]);
    expect(await runQueryEmbeddingDelivery(db, { ...options, qwenEmbedder: { embed } })).toEqual({
      accepted: true,
    });
    expect(embed).toHaveBeenCalledWith(["query"], expect.objectContaining({ purpose: "query" }));
    expect(createProviderEmbedder).not.toHaveBeenCalled();
  });

  it("a SYSTEM_BUILTIN pin without a Qwen runtime fails closed and scrubs the request", async () => {
    claimed();
    vi.mocked(dispatchQueryEmbedding).mockResolvedValue(pin("SYSTEM_BUILTIN"));
    await expect(runQueryEmbeddingDelivery(db, options)).rejects.toThrow(
      /^Query embedding unavailable$/,
    );
    expect(createProviderEmbedder).not.toHaveBeenCalled();
    expect(completeQueryEmbedding).not.toHaveBeenCalled();
    expect(failQueryEmbedding).toHaveBeenCalled();
  });

  it("an OpenAI pin never reaches the Qwen child", async () => {
    claimed();
    vi.mocked(dispatchQueryEmbedding).mockResolvedValue(pin("OPENAI_COMPAT"));
    vi.mocked(completeQueryEmbedding).mockResolvedValue({ accepted: true });
    const provider = vi.fn(async () => [[1, 0]]);
    vi.mocked(createProviderEmbedder).mockReturnValue({ embed: provider });
    const qwen = vi.fn();
    await runQueryEmbeddingDelivery(db, { ...options, qwenEmbedder: { embed: qwen } });
    expect(qwen).not.toHaveBeenCalled();
    expect(provider).toHaveBeenCalledOnce();
    expect(createProviderEmbedder).toHaveBeenCalledWith(expect.anything(), {
      providerId: "p".repeat(24),
      revision: 1,
      ownerId: "owner",
    });
  });
});
