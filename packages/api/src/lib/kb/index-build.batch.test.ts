import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexBuildSnapshot } from "./generations";
import { buildAttempt } from "./index-build";
import { DurableJobFenceError } from "./jobs";
import type { LockQuery } from "./lock";

const fixture = vi.hoisted(() => ({
  entries: "",
  blobs: new Map<string, Buffer>(),
  writer: {
    tempPath: "/unused/index.tmp",
    sizeBytes: () => 1,
    appendDocument: vi.fn(),
    abort: vi.fn(),
  },
}));
vi.mock("@knowledge-base/db", async () => ({
  default: (await import("vitest-mock-extended")).mockDeep(),
}));
vi.mock("@knowledge-base/queue", () => ({}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  mkdir: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: (
    _file: string,
    args: string[],
    _options: unknown,
    callback: (error: Error | null, bytes: Buffer) => void,
  ) => {
    const output =
      args[0] === "ls-tree"
        ? fixture.entries
        : args[1]?.includes("manifest.json")
          ? '{"version":1,"entries":[]}'
          : "2026-11-01T00:00:00.000Z";
    queueMicrotask(() => callback(null, Buffer.from(output)));
    return { kill: vi.fn() };
  },
}));
vi.mock("./git-read", async (original) => ({
  ...(await original<typeof import("./git-read")>()),
  readBlobsAsync: vi.fn(async () => fixture.blobs),
}));
vi.mock("./index-file/files", () => ({
  removeEarlierAttemptTemps: vi.fn(),
  unlinkIndexFile: vi.fn(async () => {}),
}));
vi.mock("./index-file/writer", async (original) => ({
  ...(await original<typeof import("./index-file/writer")>()),
  openIndexWriter: () => fixture.writer,
}));
vi.mock("./quota", () => ({
  reserveQuota: vi.fn(async () => ({ reservationIds: ["reservation"] })),
  releaseQuota: vi.fn(),
  statfsDiskMeter: vi.fn(),
}));

const snapshot: IndexBuildSnapshot = {
  mode: "lexical",
  generationId: "g".repeat(24),
  kbId: "k".repeat(24),
  epoch: "1",
  commitSha: "a".repeat(40),
  quantization: "int8",
};
beforeEach(() => {
  vi.clearAllMocks();
  fixture.blobs = new Map();
});

function documents(count: number) {
  fixture.entries = Array.from({ length: count }, (_, i) => {
    const bytes = Buffer.from(`# Document ${i}\n\nContent for ${i}.\n`);
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    fixture.blobs.set(sha, bytes);
    return `100644 blob ${sha}\tdoc-${String(i).padStart(3, "0")}.md\0`;
  }).join("");
}

function accounting(failCount = false) {
  let rows: unknown[][] = [];
  let documentCount = 0;
  let chunkCount = 0;
  let transaction = 0;
  const inserts: Array<{ sql: string; values: unknown[]; transaction: number }> = [];
  const counts: Array<{ values: unknown[]; transaction: number }> = [];
  // SQL/authority are mocked; each fenced callback gets one atomic ledger snapshot.
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith("INSERT INTO generation_document")) {
      inserts.push({ sql, values, transaction });
      for (let i = 0; i < values.length; i += 7) rows.push(values.slice(i, i + 7));
    }
    if (sql.startsWith('UPDATE index_generation SET "documentCount"')) {
      counts.push({ values, transaction });
      if (failCount) return { rows: [], rowCount: 0 };
      documentCount = Number(values[1]);
      chunkCount = Number(values[2]);
    }
    return { rows: [], rowCount: 1 };
  });
  const fenced = async <T>(run: (q: LockQuery) => Promise<T>): Promise<T> => {
    const prior = { rows: [...rows], documentCount, chunkCount };
    transaction++;
    try {
      return await run(query as LockQuery);
    } catch (error) {
      ({ rows, documentCount, chunkCount } = prior);
      throw error;
    }
  };
  return { fenced, inserts, counts, state: () => ({ rows, documentCount, chunkCount }) };
}

async function pass1(ledger: ReturnType<typeof accounting>) {
  const endOfPass1 = new DurableJobFenceError();
  await expect(
    buildAttempt(
      {
        connectionString: "must-not-connect",
        reposDir: "/unused",
        indexDir: "/unused",
        masterKey: undefined,
        workerId: "test",
        durableJobId: "job",
        afterPass1: async () => {
          throw endOfPass1;
        },
      },
      snapshot,
      { jobId: "job", workerId: "test", epoch: 7 },
      ledger.fenced,
      new AbortController().signal,
      async () => {},
    ),
  ).rejects.toBeInstanceOf(DurableJobFenceError);
}

describe("pass-1 document batch accounting", () => {
  it("inserts each bounded batch in one parameterized statement with its fenced count update", async () => {
    documents(65);
    const ledger = accounting();
    await pass1(ledger);
    expect(ledger.inserts.map((entry) => entry.values.length / 7)).toEqual([64, 1]);
    expect(ledger.state()).toMatchObject({ documentCount: 65, chunkCount: 65 });
    expect(ledger.state().rows).toHaveLength(65);
    for (let i = 0; i < ledger.inserts.length; i++) {
      const insert = ledger.inserts[i]!;
      expect(insert.transaction).toBe(ledger.counts[i]!.transaction);
      expect(insert.sql).not.toContain("doc-");
      expect(insert.sql.match(/::"GenerationDocumentState"/g)).toHaveLength(
        insert.values.length / 7,
      );
    }
    expect(ledger.state().rows[0]).toEqual([
      snapshot.generationId,
      "doc-000.md",
      expect.stringMatching(/^[a-f0-9]{40}$/),
      expect.any(String),
      1,
      1,
      "INDEXED",
    ]);
    expect(ledger.counts.at(-1)?.values).toEqual([snapshot.generationId, 65, 65, 7]);
  });

  it("rolls the multi-document insert back if its attempt-count fence is lost", async () => {
    documents(3);
    const ledger = accounting(true);
    await pass1(ledger);
    expect(ledger.inserts).toHaveLength(1);
    expect(ledger.inserts[0]!.values).toHaveLength(21);
    expect(ledger.state()).toEqual({ rows: [], documentCount: 0, chunkCount: 0 });
    expect(fixture.writer.abort).toHaveBeenCalledOnce();
  });

  it("does not emit an empty INSERT for an empty tree", async () => {
    documents(0);
    const ledger = accounting();
    await pass1(ledger);
    expect(ledger.inserts).toEqual([]);
    expect(ledger.state()).toEqual({ rows: [], documentCount: 0, chunkCount: 0 });
    expect(ledger.counts.at(-1)?.values).toEqual([snapshot.generationId, 0, 0, 7]);
  });
});
