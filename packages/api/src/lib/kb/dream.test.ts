import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { PlannedChange } from "./changes-plan";
import { walkGitTreeAtCommit } from "./changes-plan";
import {
  dreamGuardTouchedPathsForUpserts,
  dreamOperationDigest,
  dreamSourceSessionsDigest,
  dreamUpsertsToPlannedChanges,
  dreamUpsertToFields,
  evaluateDreamMergeGuardAsync,
  formatDreamCommitMessage,
  mergePersistedDreamMetadata,
  parseDreamChangesApplyRequest,
  planDreamPublication,
  scanDreamRequestForSensitive,
} from "./dream";
import { KbDomainError } from "./errors";
import { writeGitFixtureCommit } from "./fixtures/git-objects";
import { kbBareRepoPath, readHeadSha, readRefSha, runGit } from "./git-read";
import { initialMainTreeFiles } from "./git-write";
import { parseMarkdownDocument, serializeDreamMarkdown } from "./parse-markdown";
import { dreamMetadataSchema } from "./protocol/common";
import { containsKnownCredentialPatterns } from "./sensitive-text";
import { stageCommitWithTreeFiles } from "./staged-tree";
import { validateGitCommit } from "./validate-tree";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(join(FIXTURE_DIR, "fixtures/dream.json"), "utf8"),
) as unknown;

type DreamFixture = { reposDir: string; kbId: string; repoPath: string; head: string };

function initialDreamTest(
  name: string,
  kbId: string,
  description: string,
  run: (fixture: DreamFixture) => void | Promise<void>,
) {
  describe(name, () => {
    let reposDir: string | undefined;
    let fixture: DreamFixture | undefined;
    let setup: Promise<void> | undefined;
    let action: Promise<void> | undefined;
    beforeAll(() => {
      // Seed private planner inputs through the shared real-Git fixture writer.
      // Planning and guard actions keep their independent 30s test deadline.
      setup = (async () => {
        const root = mkdtempSync(join(tmpdir(), "kb-dream-unit-"));
        reposDir = root;
        const repoPath = kbBareRepoPath(root, kbId);
        runGit(root, ["init", "--bare", repoPath]);
        const head = writeGitFixtureCommit(repoPath, {
          parentSha: "0".repeat(40),
          message: "init",
          files: initialMainTreeFiles(description),
        });
        runGit(repoPath, ["update-ref", "refs/heads/main", head]);
        fixture = { reposDir: root, kbId, repoPath, head };
      })();
      return setup;
    }, 180_000);
    afterEach(async () => {
      await action?.catch(() => {});
    }, 180_000);
    afterAll(async () => {
      await setup?.catch(() => {});
      await action?.catch(() => {});
      if (reposDir) rmSync(reposDir, { recursive: true, force: true });
    }, 180_000);
    it("preserves the dream invariant", () => {
      action = Promise.resolve().then(() => {
        if (!fixture) throw new Error("Dream fixture is not ready");
        return run(fixture);
      });
      return action;
    });
  });
}

/** Seed and validate private planner inputs, retaining the expected-old ref CAS. */
async function commitToRef(
  reposDir: string,
  kbId: string,
  refName: string,
  parentSha: string,
  message: string,
  changes: PlannedChange[],
): Promise<string> {
  const repoPath = kbBareRepoPath(reposDir, kbId);
  const planned = await walkGitTreeAtCommit({ repoPath, baseRevision: parentSha, changes });
  if (!planned.ok) throw new Error(planned.message);
  const commit = writeGitFixtureCommit(repoPath, { parentSha, message, files: planned.files });
  const validation = validateGitCommit({ repoPath }, commit);
  if (!validation.ok) throw new Error("staged commit failed validation");
  runGit(repoPath, [
    "update-ref",
    refName,
    commit,
    readRefSha(repoPath, refName) ?? "0".repeat(40),
  ]);
  return commit;
}

describe("dream serialization", () => {
  const dream = dreamMetadataSchema.parse(FIXTURE);

  it("round-trips typed ConceptUpsert fields into deterministic Markdown", () => {
    const first = dream.upserts[0]!;
    const markdown = serializeDreamMarkdown({
      id: first.id,
      type: first.type,
      title: first.title,
      citations: first.citations,
      body: first.body,
    });
    expect(markdown).toMatch(/^---\nid: "alpha-note"/);
    expect(markdown).toContain("provenance: dream");
    expect(markdown.indexOf('label: "a"')).toBeLessThan(markdown.indexOf('label: "b"'));
    const again = serializeDreamMarkdown({
      id: first.id,
      type: first.type,
      title: first.title,
      citations: [...first.citations].reverse(),
      body: first.body,
    });
    expect(again).toBe(markdown);
    const parsed = parseMarkdownDocument(Buffer.from(markdown, "utf8"));
    expect("code" in parsed).toBe(false);
    if ("code" in parsed) return;
    expect(parsed.documentId).toBe("alpha-note");
  });

  it("round-trips numeric-looking ids and types as strings", () => {
    const markdown = serializeDreamMarkdown({
      id: "123",
      type: "123",
      title: "a\rb",
      citations: [{ label: "007", target: "concepts/x.md" }],
      body: "body",
    });
    const parsed = parseMarkdownDocument(Buffer.from(markdown, "utf8"));
    expect("code" in parsed).toBe(false);
    if ("code" in parsed) return;
    expect(parsed.documentId).toBe("123");
    expect(parsed.frontMatter.type).toBe("123");
    expect(parsed.frontMatter.title).toBe("a\rb");
  });

  initialDreamTest(
    "same dream input and base yield identical staged trees",
    "dreamunitkb123456789012345678",
    "dream unit kb",
    async ({ repoPath, head }) => {
      const changes = await dreamUpsertsToPlannedChanges({ repoPath, baseRevision: head, dream });
      const left = await walkGitTreeAtCommit({ repoPath, baseRevision: head, changes });
      const right = await walkGitTreeAtCommit({ repoPath, baseRevision: head, changes });
      expect(left.ok && right.ok).toBe(true);
      if (!left.ok || !right.ok) return;
      const stagedLeft = stageCommitWithTreeFiles({
        parentSha: head,
        message: "left",
        files: left.files,
      });
      const stagedRight = stageCommitWithTreeFiles({
        parentSha: head,
        message: "right",
        files: right.files,
      });
      expect(stagedLeft.rootTreeSha).toBe(stagedRight.rootTreeSha);
    },
  );
});

describe("dream paths", () => {
  initialDreamTest(
    "a new id mapping to a reserved path says why, at that upsert's id",
    "dreamreservedkb12345678901234",
    "dream reserved kb",
    async ({ repoPath, head }) => {
      const upsert = (id: string) => ({
        id,
        type: "concept",
        title: null,
        citations: [] as [],
        body: "x\n",
        provenance: "dream" as const,
      });
      const reserved = dreamMetadataSchema.parse({
        model: { provider: "p", model: "m" },
        redactionApplied: true,
        upserts: [upsert("fine"), upsert("con")],
      });
      await expect(
        dreamUpsertsToPlannedChanges({ repoPath, baseRevision: head, dream: reserved }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
        details: { reason: "RESERVED_PATH", field: "/dream/upserts/1/id" },
      });
    },
  );
});

describe("dream request validation", () => {
  it("rejects a NUL title as an invalid argument before publication", () => {
    expect(() =>
      parseDreamChangesApplyRequest({
        mode: "dream",
        baseRevision: "a".repeat(40),
        title: "bad\0title",
        changes: [],
        sourceSessionIds: [],
        dream: dreamMetadataSchema.parse(FIXTURE),
      }),
    ).toThrow(
      expect.objectContaining({
        code: "INVALID_ARGUMENT",
        message: expect.stringContaining("NUL"),
      }),
    );
  });

  it("rejects dream requests that carry generic changes", () => {
    expect(() =>
      parseDreamChangesApplyRequest({
        mode: "dream",
        baseRevision: "a".repeat(40),
        title: "t",
        changes: [{ op: "delete", path: "human.md" }],
        sourceSessionIds: [],
        dream: {
          model: { provider: "p", model: "m" },
          redactionApplied: true,
          upserts: [],
        },
      }),
    ).toThrow(/empty changes/u);
  });

  it("rejects credential patterns in title and model metadata", () => {
    const base = {
      mode: "dream" as const,
      baseRevision: "a".repeat(40),
      title: "safe",
      changes: [] as [],
      sourceSessionIds: ["00000000-0000-4000-8000-000000000001"],
      dream: {
        model: { provider: "p", model: "m" },
        redactionApplied: true as const,
        upserts: [],
      },
    };
    expect(() =>
      scanDreamRequestForSensitive({
        ...base,
        title: "sk-proj-abcdefghijklmnopqrstuvwxyz",
      }),
    ).toThrow(KbDomainError);
    expect(() =>
      scanDreamRequestForSensitive({
        ...base,
        dream: {
          ...base.dream,
          model: { provider: "sk-proj-abcdefghijklmnopqrstuvwxyz", model: "m" },
        },
      }),
    ).toThrow(KbDomainError);
  });
});

describe("persisted dream metadata", () => {
  const first = dreamMetadataSchema.parse({
    model: { provider: "p", model: "m" },
    redactionApplied: true,
    upserts: [
      {
        id: "a",
        type: "concept",
        title: "a",
        body: "a",
        citations: [],
        provenance: "dream",
      },
    ],
  });
  const second = dreamMetadataSchema.parse({
    model: { provider: "p2", model: "m2" },
    redactionApplied: true,
    upserts: [
      {
        id: "b",
        type: "concept",
        title: "b",
        body: "b",
        citations: [],
        provenance: "dream",
      },
    ],
  });

  it("merges upserts and guard paths cumulatively", () => {
    const merged = mergePersistedDreamMetadata(
      mergePersistedDreamMetadata(null, first, {
        a: [{ path: "notes/a.md", existedAtBase: true }],
      }),
      second,
      { b: [{ path: "notes/b.md", existedAtBase: false }] },
    );
    expect(merged.upserts.map((u) => u.id)).toEqual(["a", "b"]);
    expect(merged.guardTouchedPaths).toEqual({
      a: [{ path: "notes/a.md", existedAtBase: true }],
      b: [{ path: "notes/b.md", existedAtBase: false }],
    });
    expect(merged.model.provider).toBe("p2");
  });

  it("retains earlier guard paths with sticky existence when a dream id moves", () => {
    const moved = mergePersistedDreamMetadata(
      mergePersistedDreamMetadata(null, first, {
        a: [{ path: "notes/a.md", existedAtBase: true }],
      }),
      first,
      {
        a: [
          { path: "notes/moved.md", existedAtBase: true },
          { path: "notes/a.md", existedAtBase: false },
        ],
      },
    );
    expect(moved.guardTouchedPaths.a).toEqual([
      { path: "notes/a.md", existedAtBase: true },
      { path: "notes/moved.md", existedAtBase: true },
    ]);
  });

  it('handles the contract-valid id "constructor" without prototype lookups', () => {
    const ctorDream = dreamMetadataSchema.parse({
      model: { provider: "p", model: "m" },
      redactionApplied: true,
      upserts: [
        {
          id: "constructor",
          type: "concept",
          title: "Ctor",
          body: "b",
          citations: [],
          provenance: "dream",
        },
      ],
    });
    const first = mergePersistedDreamMetadata(null, ctorDream, {
      constructor: [{ path: "concepts/constructor.md", existedAtBase: false }],
    });
    expect(first.guardTouchedPaths.constructor).toEqual([
      { path: "concepts/constructor.md", existedAtBase: false },
    ]);
    // A later batch with a different id must still read the persisted
    // "constructor" entry as an own property, not Object.prototype members.
    const second = dreamMetadataSchema.parse({
      model: { provider: "p", model: "m" },
      redactionApplied: true,
      upserts: [
        {
          id: "other",
          type: "concept",
          title: "Other",
          body: "b",
          citations: [],
          provenance: "dream",
        },
      ],
    });
    const merged = mergePersistedDreamMetadata(first, second, {
      other: [{ path: "concepts/other.md", existedAtBase: false }],
    });
    expect(merged.guardTouchedPaths.constructor).toEqual([
      { path: "concepts/constructor.md", existedAtBase: false },
    ]);
  });
});

describe("dream guards", () => {
  it("documents sensitive detection as a conservative floor, not complete detection", () => {
    expect(containsKnownCredentialPatterns("harmless text")).toBe(false);
    expect(containsKnownCredentialPatterns("custom secret=not-covered")).toBe(false);
  });

  it("formats commit trailers with digests only", () => {
    const dream = dreamMetadataSchema.parse({
      model: { provider: "p", model: "m" },
      redactionApplied: true,
      upserts: [],
    });
    const session = "00000000-0000-4000-8000-000000000001";
    const message = formatDreamCommitMessage("title", [session], dream);
    expect(message).toContain("Kb-Op-Digest: sha256:");
    expect(message).not.toContain(session);
    expect(dreamOperationDigest(dream, [session])).toHaveLength(64);
  });

  initialDreamTest(
    "rejects merge when main path has human provenance",
    "dreamguardkb123456789012345678",
    "dream guard kb",
    async ({ reposDir, kbId, repoPath, head }) => {
      const humanDoc = serializeDreamMarkdown({
        id: "note",
        type: "concept",
        title: "Human",
        citations: [],
        body: "edited on main",
      }).replace("provenance: dream", "provenance: human");
      const mainHead = await commitToRef(reposDir, kbId, "refs/heads/main", head, "human edit", [
        { op: "create", path: "concepts/note.md", content: { markdown: humanDoc } },
      ]);
      const dream = dreamMetadataSchema.parse({
        model: { provider: "p", model: "m" },
        redactionApplied: true,
        upserts: [
          {
            id: "note",
            type: "concept",
            title: "Dream",
            body: "dream body",
            citations: [],
            provenance: "dream",
          },
        ],
      });
      const guard = await evaluateDreamMergeGuardAsync({ repoPath, mainHead, dream });
      expect(guard.ok).toBe(false);
    },
  );

  initialDreamTest(
    "uses persisted touched paths when main no longer maps the document id",
    "dreampathkb123456789012345678",
    "dream path kb",
    async ({ reposDir, kbId, repoPath, head }) => {
      const originalPath = "notes/original.md";
      const doc = serializeDreamMarkdown({
        id: "note",
        type: "concept",
        title: "Orig",
        citations: [],
        body: "original",
      });
      const mainHead = await commitToRef(reposDir, kbId, "refs/heads/main", head, "seed", [
        { op: "create", path: originalPath, content: { markdown: doc } },
      ]);
      const human = serializeDreamMarkdown({
        id: "other",
        type: "concept",
        title: "Human",
        citations: [],
        body: "human at fallback path",
      }).replace("provenance: dream", "provenance: human");
      await commitToRef(reposDir, kbId, "refs/heads/main", mainHead, "human remap", [
        { op: "delete", path: originalPath },
        { op: "create", path: "concepts/note.md", content: { markdown: human } },
      ]);
      const dream = dreamMetadataSchema.parse({
        model: { provider: "p", model: "m" },
        redactionApplied: true,
        upserts: [
          {
            id: "note",
            type: "concept",
            title: "Dream",
            body: "dream body",
            citations: [],
            provenance: "dream",
          },
        ],
      });
      const guard = await evaluateDreamMergeGuardAsync({
        repoPath,
        mainHead: readHeadSha(repoPath)!,
        dream: {
          ...dream,
          guardTouchedPaths: { note: [{ path: originalPath, existedAtBase: true }] },
        },
      });
      expect(guard.ok).toBe(false);
    },
  );

  initialDreamTest(
    "allows a dream proposal for a brand-new document against unchanged main",
    "dreamnewkb1234567890123456789",
    "dream new kb",
    async ({ repoPath, head }) => {
      const dream = dreamMetadataSchema.parse({
        model: { provider: "p", model: "m" },
        redactionApplied: true,
        upserts: [
          {
            id: "new",
            type: "concept",
            title: "New",
            body: "brand new",
            citations: [],
            provenance: "dream",
          },
        ],
      });
      const touched = await dreamGuardTouchedPathsForUpserts({
        repoPath,
        baseRevision: head,
        guardBaseRevision: head,
        dream,
      });
      expect(touched.new).toEqual([{ path: "concepts/new.md", existedAtBase: false }]);
      const persisted = mergePersistedDreamMetadata(null, dream, touched);
      const guard = await evaluateDreamMergeGuardAsync({
        repoPath,
        mainHead: head,
        dream: persisted,
      });
      expect(guard.ok).toBe(true);
    },
  );

  initialDreamTest(
    "flags removal of a path that existed at the proposal base",
    "dreampathkb1234567890123456789",
    "dream remove kb",
    async ({ reposDir, kbId, repoPath, head }) => {
      const originalPath = "notes/original.md";
      const mainBase = await commitToRef(reposDir, kbId, "refs/heads/main", head, "seed", [
        {
          op: "create",
          path: originalPath,
          content: {
            markdown: serializeDreamMarkdown({
              id: "note",
              type: "concept",
              title: "Note",
              citations: [],
              body: "note",
            }),
          },
        },
      ]);
      const dream = dreamMetadataSchema.parse({
        model: { provider: "p", model: "m" },
        redactionApplied: true,
        upserts: [
          {
            id: "note",
            type: "concept",
            title: "Dream",
            body: "dream body",
            citations: [],
            provenance: "dream",
          },
        ],
      });
      const touched = await dreamGuardTouchedPathsForUpserts({
        repoPath,
        baseRevision: mainBase,
        guardBaseRevision: mainBase,
        dream,
      });
      expect(touched.note?.[0]?.existedAtBase).toBe(true);
      const mainHead = await commitToRef(reposDir, kbId, "refs/heads/main", mainBase, "remove", [
        { op: "delete", path: originalPath },
      ]);
      const persisted = mergePersistedDreamMetadata(null, dream, touched);
      const guard = await evaluateDreamMergeGuardAsync({ repoPath, mainHead, dream: persisted });
      expect(guard.ok).toBe(false);
      if (!guard.ok) expect(guard.message).toContain("removed");
    },
  );

  initialDreamTest(
    "blocks human main edits at earlier paths after a dream id moves within a proposal",
    "dreammovekb123456789012345678",
    "dream move kb",
    async ({ reposDir, kbId, repoPath, head }) => {
      const dream = dreamMetadataSchema.parse({
        model: { provider: "p", model: "m" },
        redactionApplied: true,
        upserts: [
          {
            id: "note",
            type: "concept",
            title: "Dream",
            body: "dream body",
            citations: [],
            provenance: "dream",
          },
        ],
      });
      const originalPath = "notes/original.md";
      const movedPath = "notes/moved.md";
      const mainBase = await commitToRef(reposDir, kbId, "refs/heads/main", head, "seed", [
        {
          op: "create",
          path: originalPath,
          content: {
            markdown: serializeDreamMarkdown({
              id: "note",
              type: "concept",
              title: "Note",
              citations: [],
              body: "note",
            }),
          },
        },
        {
          op: "create",
          path: movedPath,
          content: {
            markdown: serializeDreamMarkdown({
              id: "other",
              type: "concept",
              title: "Other",
              citations: [],
              body: "other",
            }),
          },
        },
      ]);
      // First dream batch proposes into notes/original.md, where id note lives.
      const firstTouched = await dreamGuardTouchedPathsForUpserts({
        repoPath,
        baseRevision: mainBase,
        guardBaseRevision: mainBase,
        dream,
      });
      expect(firstTouched.note).toEqual([{ path: originalPath, existedAtBase: true }]);
      // An ordinary proposal edit then re-assigns id note to the other path.
      const prHead = await commitToRef(
        reposDir,
        kbId,
        "refs/heads/kb/pr-7777",
        mainBase,
        "ordinary edit remaps ids",
        [
          {
            op: "replace",
            path: originalPath,
            content: {
              markdown: serializeDreamMarkdown({
                id: "retired",
                type: "concept",
                title: "Retired",
                citations: [],
                body: "retired",
              }),
            },
          },
          {
            op: "replace",
            path: movedPath,
            content: {
              markdown: serializeDreamMarkdown({
                id: "note",
                type: "concept",
                title: "Remap",
                citations: [],
                body: "remapped",
              }),
            },
          },
        ],
      );
      // A second dream batch on the proposal head resolves id note at the new path.
      const secondTouched = await dreamGuardTouchedPathsForUpserts({
        repoPath,
        baseRevision: prHead,
        guardBaseRevision: mainBase,
        dream,
      });
      expect(secondTouched.note).toEqual([{ path: movedPath, existedAtBase: true }]);
      const persisted = mergePersistedDreamMetadata(
        mergePersistedDreamMetadata(null, dream, firstTouched),
        dream,
        secondTouched,
      );
      expect(persisted.guardTouchedPaths.note?.map((record) => record.path)).toEqual([
        movedPath,
        originalPath,
      ]);
      // A later human edit on main at the earlier path must still conflict.
      const human = serializeDreamMarkdown({
        id: "note",
        type: "concept",
        title: "Human",
        citations: [],
        body: "human edited",
      }).replace("provenance: dream", "provenance: human");
      const mainHead = await commitToRef(
        reposDir,
        kbId,
        "refs/heads/main",
        mainBase,
        "human edit",
        [{ op: "replace", path: originalPath, content: { markdown: human } }],
      );
      const guard = await evaluateDreamMergeGuardAsync({ repoPath, mainHead, dream: persisted });
      expect(guard.ok).toBe(false);
      if (!guard.ok) expect(guard.message).toContain(originalPath);
    },
  );

  initialDreamTest(
    'plans and guards a dream batch whose id is "constructor"',
    "dreamctorkb1234567890123456789",
    "dream ctor kb",
    async ({ repoPath, head }) => {
      const ctorDream = dreamMetadataSchema.parse({
        model: { provider: "p", model: "m" },
        redactionApplied: true,
        upserts: [
          {
            id: "constructor",
            type: "concept",
            title: "Ctor",
            body: "ctor body",
            citations: [],
            provenance: "dream",
          },
        ],
      });
      const changes = await dreamUpsertsToPlannedChanges({
        repoPath,
        baseRevision: head,
        dream: ctorDream,
      });
      expect(changes.map((change) => [change.op, change.path])).toEqual([
        ["create", "concepts/constructor.md"],
      ]);
      const touched = await dreamGuardTouchedPathsForUpserts({
        repoPath,
        baseRevision: head,
        guardBaseRevision: head,
        dream: ctorDream,
      });
      const persisted = mergePersistedDreamMetadata(null, ctorDream, touched);
      const guard = await evaluateDreamMergeGuardAsync({
        repoPath,
        mainHead: head,
        dream: persisted,
      });
      expect(guard.ok).toBe(true);
    },
  );

  initialDreamTest(
    "rejects credential literals that YAML escaping hides from the serialized form",
    "dreamsmugglekb1234567890123",
    "dream smuggle kb",
    async ({ repoPath, head }) => {
      // A literal tab between scheme and token: recognized in the original
      // title, but JSON.stringify escapes it to backslash-t in the serialized
      // front matter, so a serialized-only scan would let it through.
      const smuggledTitle = "Bearer\tsynthetic-review-token-0123456789";
      expect(containsKnownCredentialPatterns(smuggledTitle)).toBe(true);
      const fields = {
        id: "smuggled",
        type: "concept",
        title: smuggledTitle,
        citations: [] as [],
        body: "body",
      };
      expect(containsKnownCredentialPatterns(serializeDreamMarkdown(fields))).toBe(false);
      const dream = dreamMetadataSchema.parse({
        model: { provider: "p", model: "m" },
        redactionApplied: true,
        upserts: [{ ...fields, provenance: "dream" }],
      });
      await expect(
        dreamUpsertsToPlannedChanges({ repoPath, baseRevision: head, dream }),
      ).rejects.toThrow(/credential/u);
    },
  );
});

type GoldenFile = { path: string; markdown: string };
type GoldenScenario = {
  name: string;
  permission: "write" | "propose";
  seed: GoldenFile[];
  sourceSessionIds: string[];
  dream: unknown;
  expect:
    | { error: string }
    | {
        kind: "applied" | "proposed" | "noop";
        changedPaths: string[];
        files: { op: string; path: string; markdown: string }[];
      };
};
type GoldenCorpus = {
  serialization: { name: string; upsert: unknown; markdown: string }[];
  digests: {
    name: string;
    dream: unknown;
    sourceSessionIds: string[];
    title: string;
    opDigest: string;
    sourceDigest: string;
    commitMessage: string;
  }[];
  scenarios: GoldenScenario[];
};

/**
 * The shared dream golden corpus (`fixtures/dream-golden.json`). The Rust
 * local backend (`apps/cli/crates/kb-local/tests/dream.rs`) asserts the same
 * Markdown bytes, paths, digests and result kinds; this suite pins the
 * server to it so either side drifting fails.
 */
describe("shared dream golden corpus", () => {
  const golden = JSON.parse(
    readFileSync(join(FIXTURE_DIR, "fixtures/dream-golden.json"), "utf8"),
  ) as GoldenCorpus;

  it("serializes every upsert to the golden Markdown bytes", () => {
    for (const entry of golden.serialization) {
      const upsert = dreamMetadataSchema.parse({
        model: { provider: "p", model: "m" },
        redactionApplied: true,
        upserts: [entry.upsert],
      }).upserts[0]!;
      expect(serializeDreamMarkdown(dreamUpsertToFields(upsert)), entry.name).toBe(entry.markdown);
    }
  });

  it("produces the golden digests and commit trailers", () => {
    for (const entry of golden.digests) {
      const dream = dreamMetadataSchema.parse(entry.dream);
      expect(`sha256:${dreamOperationDigest(dream, entry.sourceSessionIds)}`, entry.name).toBe(
        entry.opDigest,
      );
      expect(`sha256:${dreamSourceSessionsDigest(entry.sourceSessionIds)}`, entry.name).toBe(
        entry.sourceDigest,
      );
      expect(formatDreamCommitMessage(entry.title, entry.sourceSessionIds, dream), entry.name).toBe(
        entry.commitMessage,
      );
    }
  });

  // Every scenario starts with its own repository and keeps the default deadline.
  describe.each(golden.scenarios)("scenario $name", (scenario) => {
    let reposDir: string;
    let repoPath: string;
    let head: string;
    const kbId = "dreamgoldenkb12345678901234";
    let setup: Promise<void> | undefined;
    beforeAll(() => {
      // Private reader/planner inputs use the shared real-Git fixture writer;
      // the planner below keeps its unchanged 30s test deadline.
      setup = (async () => {
        reposDir = mkdtempSync(join(tmpdir(), "kb-dream-golden-"));
        repoPath = kbBareRepoPath(reposDir, kbId);
        runGit(reposDir, ["init", "--bare", repoPath]);
        const files = initialMainTreeFiles("dream golden kb");
        head = writeGitFixtureCommit(repoPath, {
          parentSha: "0".repeat(40),
          message: "init",
          files,
        });
        runGit(repoPath, ["update-ref", "refs/heads/main", head]);
        if (scenario.seed.length > 0) {
          const oldHead = head;
          head = writeGitFixtureCommit(repoPath, {
            parentSha: oldHead,
            message: "seed",
            files: [
              ...files,
              ...scenario.seed.map((file) => ({
                segments: file.path.split("/"),
                content: Buffer.from(file.markdown),
              })),
            ],
          });
          const validation = validateGitCommit({ repoPath }, head);
          if (!validation.ok) throw new Error("golden seed failed validation");
          runGit(repoPath, ["update-ref", "refs/heads/main", head, oldHead]);
        }
      })();
      return setup;
    }, 180_000);
    afterAll(async () => {
      // Join late/failed preparation before removing its private repository.
      await setup?.catch(() => {});
      if (reposDir) rmSync(reposDir, { recursive: true, force: true });
    }, 180_000);

    it("plans the golden paths, bytes and result kind", async () => {
      let actual: GoldenScenario["expect"];
      try {
        const request = parseDreamChangesApplyRequest({
          mode: "dream",
          baseRevision: head,
          title: "Dream",
          changes: [],
          sourceSessionIds: scenario.sourceSessionIds,
          dream: scenario.dream,
        });
        scanDreamRequestForSensitive(request);
        const plan = await planDreamPublication({
          repoPath,
          baseRevision: head,
          dream: request.dream,
          sourceSessionIds: request.sourceSessionIds,
        });
        actual = plan.noop
          ? { kind: "noop", changedPaths: [], files: [] }
          : {
              kind: scenario.permission === "write" ? "applied" : "proposed",
              changedPaths: plan.planned?.ok ? plan.planned.changedPaths : [],
              files: plan.changes.map((change) => ({
                op: change.op,
                path: change.path,
                markdown: "content" in change ? change.content.markdown : "",
              })),
            };
      } catch (error) {
        if (!(error instanceof KbDomainError)) throw error;
        actual = { error: error.code };
      }
      expect(actual, scenario.name).toEqual(scenario.expect);
    });
  });
});
