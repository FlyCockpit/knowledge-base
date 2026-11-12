import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("./authority-lock", () => ({ runLockedOperation: vi.fn() }));
vi.mock("@knowledge-base/db", () => ({ default: {} }));

import { unavailableIndexStatus } from "./attachment";
import { runLockedOperation } from "./authority-lock";
import { EmbeddingUnavailableError } from "./embed-client";
import { KbDomainError } from "./errors";
import { DurableJobFenceError } from "./jobs";
import { createMemoryRatePort } from "./limits";
import {
  beginQueryEmbedding,
  degradableKind,
  EmbeddingFailedError,
  EmbeddingPhaseExpired,
  LexicalOnlySearchError,
  ProfileLostError,
  withLexicalSearch,
  withQueryEmbedding,
} from "./query-embedding";

const options = {
  connectionString: "unused",
  masterKey: undefined,
  ratePort: createMemoryRatePort(),
};
const actor = { principal: { kind: "browser" as const, userId: "fixture" } };
const kbId = "k".repeat(24);
describe("query admission", () => {
  it.each(["", "x".repeat(1025), "😀".repeat(1025), "canary\0value"])(
    "rejects empty/oversized input before DB or queue",
    async (query) => {
      await expect(beginQueryEmbedding(options, actor, { kbId, query })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      expect(runLockedOperation).not.toHaveBeenCalled();
    },
  );
  it("counts the 1024-character bound in Unicode scalars, not UTF-16 units", async () => {
    await expect(
      beginQueryEmbedding(options, actor, { kbId, query: "\u{1F9ED}".repeat(1025) }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    // A complete astral query passes validation and reaches the (pre-aborted) admission step.
    const abort = new AbortController();
    abort.abort();
    await expect(
      beginQueryEmbedding(options, actor, { kbId, query: "\u{1F9ED}".repeat(1024) }, abort.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(runLockedOperation).not.toHaveBeenCalled();
  });
  it.each([0, 60_001])("bounds the deadline before admission", async (timeoutMs) => {
    await expect(
      beginQueryEmbedding(options, actor, { kbId, query: "valid", timeoutMs }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(runLockedOperation).not.toHaveBeenCalled();
  });
  it("rejects an expired caller deadline before semantic admission", async () => {
    const expired = { ...options, deadlineAt: Date.now() - 1 };
    await expect(
      beginQueryEmbedding(expired, actor, { kbId, query: "valid" }),
    ).rejects.toMatchObject({
      code: "DEADLINE_EXCEEDED",
    });
    await expect(
      withQueryEmbedding(expired, actor, { kbId, query: "valid" }, async () => "late"),
    ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
    expect(runLockedOperation).not.toHaveBeenCalled();
  });
  it.each(["continuation", "caller"] as const)(
    "rejects an expired %s deadline before lexical admission or consumption",
    async (expired) => {
      const now = Date.now();
      const target = new LexicalOnlySearchError(
        "g".repeat(24),
        unavailableIndexStatus(null),
        false,
        now + (expired === "continuation" ? -1 : 60_000),
        true,
      );
      const consume = vi.fn(async () => "late");
      await expect(
        withLexicalSearch(
          { ...options, deadlineAt: now + (expired === "caller" ? -1 : 60_000) },
          actor,
          { kbId },
          target,
          consume,
        ),
      ).rejects.toMatchObject({ code: "DEADLINE_EXCEEDED" });
      expect(runLockedOperation).not.toHaveBeenCalled();
      expect(consume).not.toHaveBeenCalled();
    },
  );
  it("rejects credential-shaped content and pre-aborted requests before persistence", async () => {
    await expect(
      beginQueryEmbedding(options, actor, { kbId, query: `sk-${"x".repeat(32)}` }),
    ).rejects.toMatchObject({ code: "SENSITIVE_QUERY" });
    const abort = new AbortController();
    abort.abort();
    await expect(
      beginQueryEmbedding(options, actor, { kbId, query: "valid" }, abort.signal),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(runLockedOperation).not.toHaveBeenCalled();
  });
  it("the API workspace module graph cannot load a native Qwen addon or worker code", () => {
    const root = fileURLToPath(new URL("../../../../../", import.meta.url));
    const visited = new Set<string>();
    const visit = (file: string) => {
      if (visited.has(file)) return;
      visited.add(file);
      const source = readFileSync(file, "utf8");
      for (const ref of source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g)) {
        const spec = ref[1]!;
        expect(spec).not.toMatch(/llama|qwen-child|apps\/worker/i);
        let target: string | undefined;
        if (spec.startsWith(".")) target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
        else if (spec.startsWith("@knowledge-base/")) {
          const [pkg, ...parts] = spec.slice("@knowledge-base/".length).split("/");
          const dir = resolve(root, "packages", pkg!);
          const manifest = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
          const entry = manifest.exports?.[parts.length ? `./${parts.join("/")}` : "."];
          const path = typeof entry === "string" ? entry : entry?.default;
          if (path) target = resolve(dir, path);
        }
        if (target) {
          const found = [target, `${target}.ts`, `${target}.tsx`, resolve(target, "index.ts")].find(
            existsSync,
          );
          if (found && /\.[cm]?tsx?$/.test(found)) visit(found);
        }
      }
    };
    visit(resolve(root, "packages/api/src/routers/index.ts"));
    visit(resolve(root, "packages/api/src/lib/kb/query-embedding.ts"));
    expect(visited.has(resolve(root, "packages/api/src/lib/kb/embedder.ts"))).toBe(true);
    expect([...visited].some((path) => path.includes("apps/worker"))).toBe(false);
  });
});

describe("closed classification of embedding failures", () => {
  it.each([
    ["profile lost", new ProfileLostError(), "PROFILE_LOST"],
    ["embedder failed", new EmbeddingFailedError(), "EMBEDDING_FAILED"],
    ["embedding timeout", new EmbeddingPhaseExpired(), "EMBEDDING_TIMEOUT"],
    // Everything else propagates: lease/request/generation (generic INDEX_UNAVAILABLE),
    // fences, authorization, deadlines, raw provider errors and SQL failures.
    ["lease or request", new KbDomainError("INDEX_UNAVAILABLE", "Index unavailable"), null],
    ["durable fence", new DurableJobFenceError(), null],
    ["authorization", new KbDomainError("NOT_FOUND", "Not found"), null],
    ["forbidden", new KbDomainError("FORBIDDEN", "Forbidden"), null],
    ["search deadline", new KbDomainError("DEADLINE_EXCEEDED", "Deadline exceeded"), null],
    ["unclassified embedder error", new EmbeddingUnavailableError(), null],
    ["sql", Object.assign(new Error("relation missing"), { code: "42P01" }), null],
    ["statement timeout", Object.assign(new Error("canceling"), { code: "57014" }), null],
    ["lock timeout", Object.assign(new Error("lock unavailable"), { code: "55P03" }), null],
  ])("%s -> %s", (_name, error, kind) => {
    expect(degradableKind(error)).toBe(kind);
  });
});
