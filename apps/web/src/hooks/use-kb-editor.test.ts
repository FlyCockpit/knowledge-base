import { browserConflictDetails } from "@knowledge-base/api/lib/kb/browser-conflict";
import { ORPCError } from "@orpc/client";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { orpc } from "@/utils/orpc";
import {
  type ApplyResultLike,
  beginImageSave,
  clearKbPrivateQueries,
  confirmableConflict,
  DOCUMENT_STAGED_ASSETS_MAX,
  describeEditorError,
  type EditedProposal,
  type EditorDeps,
  type EditorOp,
  type EditorStagedImage,
  INLINE_MARKDOWN_MAX_BYTES,
  imageAssetPath,
  imageMarkdown,
  initialEditorMemory,
  isAccessLoss,
  isPathNotFound,
  kbControls,
  linkedStagedImages,
  previewAfterSaves,
  proposalAfterAdopt,
  proposalAfterSave,
  recheckKbAccess,
  runEditorOp,
  runImageStage,
  runSave,
  type StagedImages,
  settleImageSave,
  settleOutcome,
  UPLOAD_BUDGET_MAX_WAITS,
} from "./use-kb-editor";

const KB = "a".repeat(24);
const OTHER_KB = "b".repeat(24);
const HEAD = "1".repeat(40);
const NEW_HEAD = "2".repeat(40);
const PR_HEAD = "3".repeat(40);
const UPLOAD = "00000000-0000-4000-8000-000000000001";
const OP_ID = "00000000-0000-4000-8000-0000000000aa";

function applied(overrides: Partial<ApplyResultLike> = {}): ApplyResultLike {
  return {
    operationId: OP_ID,
    kind: "applied",
    commitSha: NEW_HEAD,
    baseRevision: HEAD,
    proposal: null,
    changedPaths: ["notes/a.md"],
    sourceSessionIds: [],
    indexJobId: "00000000-0000-4000-8000-0000000000bb",
    ...overrides,
  };
}

type Call = { op: string; input: Record<string, unknown> };

function recorder(
  respond: (op: string, input: Record<string, unknown>) => unknown = () => applied(),
) {
  const calls: Call[] = [];
  let n = 0;
  const call = (op: string) => async (input: Record<string, unknown>) => {
    calls.push({ op, input });
    const out = respond(op, input);
    if (out instanceof Error) throw out;
    return out;
  };
  const deps: EditorDeps = {
    create: call("create") as EditorDeps["create"],
    update: call("update") as EditorDeps["update"],
    remove: call("delete") as EditorDeps["remove"],
    uploadBegin: call("uploadBegin") as EditorDeps["uploadBegin"],
    uploadWrite: call("uploadWrite") as EditorDeps["uploadWrite"],
    uploadFinish: call("uploadFinish") as EditorDeps["uploadFinish"],
    newKey: () => `key-${String(++n).padStart(16, "0")}`,
    sha256Hex: async () => "f".repeat(64),
  };
  return { calls, deps };
}

const BASE = "5".repeat(40);

/** A domain PROPOSAL_CONFLICT detail object, as `proposalConflictError` builds it. */
function domainProposalConflict() {
  return {
    headSha: HEAD,
    proposalNumber: 4,
    reason: "PROPOSAL_CONFLICT" as const,
    baseSha: BASE,
    proposalHeadSha: PR_HEAD,
    contentIncluded: true,
    paths: [
      {
        path: "a.md",
        kind: "document" as const,
        base: "# base\n",
        theirs: "# main\n",
        yours: "# mine\n",
        baseSha: BASE,
        theirsSha: HEAD,
        yoursSha: PR_HEAD,
      },
      {
        path: "assets/x.png",
        kind: "asset" as const,
        base: null,
        theirs: "{}",
        yours: "{}",
        baseSha: BASE,
        theirsSha: HEAD,
        yoursSha: PR_HEAD,
      },
    ],
  };
}

/** The CONFLICT error the documents router throws (`documentErrorToOrpc`). */
function routerConflict(domainDetails: unknown) {
  return new ORPCError("CONFLICT", {
    message: "conflict",
    data: { code: "CONFLICT", details: browserConflictDetails(domainDetails) ?? {} },
  });
}

const orpcError = (code: string, data?: unknown) =>
  Object.assign(new Error(code), { code, data, status: 409 });

const update = (markdown: string): EditorOp => ({ kind: "update", path: "notes/a.md", markdown });

describe("kbControls: effective capability bits drive controls", () => {
  it("read-only KB exposes no edit or manage controls", () => {
    const c = kbControls(["read"]);
    expect(c).toMatchObject({ canRead: true, editMode: "none", canManage: false });
  });
  it("propose without write edits as a proposal, never as a main update", () => {
    expect(kbControls(["read", "propose"]).editMode).toBe("proposal");
  });
  it("write edits main directly", () => {
    expect(kbControls(["read", "propose", "write"]).editMode).toBe("direct");
  });
  it("manage enables metadata and delete controls", () => {
    expect(kbControls(["read", "manage"]).canManage).toBe(true);
  });
  it("create-only grant bits without read never enable reading", () => {
    const c = kbControls(["propose"]);
    expect(c.canRead).toBe(false);
    expect(c.editMode).toBe("none");
  });
  it("empty bits (no private access) expose nothing", () => {
    expect(kbControls([])).toEqual({
      canRead: false,
      editMode: "none",
      canManage: false,
      canReview: false,
    });
  });
});

describe("runEditorOp", () => {
  it("sends the full branch baseRevision and a per-attempt idempotency key", async () => {
    const { calls, deps } = recorder();
    const out = await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: update("# hi\n"),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.op).toBe("update");
    expect(calls[0]?.input).toEqual({
      kbId: KB,
      baseRevision: HEAD,
      path: "notes/a.md",
      content: { markdown: "# hi\n" },
      idempotencyKey: "key-0000000000000001",
    });
    expect(out.outcome.kind).toBe("applied");
  });

  it("names the proposal it edits once one is chosen", async () => {
    const { calls, deps } = recorder();
    await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: update("# pr\n"),
      proposalNumber: 7,
    });
    expect(calls[0]?.input).toMatchObject({ baseRevision: HEAD, proposalNumber: 7 });
  });

  it("reuses the same key when retrying the SAME payload after a transport failure", async () => {
    let fail = true;
    const { calls, deps } = recorder(() => {
      if (fail) {
        fail = false;
        return new TypeError("Failed to fetch");
      }
      return applied();
    });
    const input = { kbId: KB, baseRevision: HEAD, op: update("x") };
    const first = await runEditorOp(deps, initialEditorMemory(), input);
    expect(first.outcome.kind).toBe("retryable");
    const second = await runEditorOp(deps, first.memory, input);
    expect(second.outcome.kind).toBe("applied");
    expect(calls[0]?.input.idempotencyKey).toBe(calls[1]?.input.idempotencyKey);
  });

  it("mints a NEW key when the payload changed between retries", async () => {
    let fail = true;
    const { calls, deps } = recorder(() => {
      if (fail) {
        fail = false;
        return new TypeError("Failed to fetch");
      }
      return applied();
    });
    const first = await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: update("x"),
    });
    await runEditorOp(deps, first.memory, { kbId: KB, baseRevision: HEAD, op: update("xy") });
    expect(calls[0]?.input.idempotencyKey).not.toBe(calls[1]?.input.idempotencyKey);
  });

  it("mints a new key when only the base revision changed", async () => {
    const { calls, deps } = recorder(() => new TypeError("Failed to fetch"));
    const first = await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: update("x"),
    });
    await runEditorOp(deps, first.memory, { kbId: KB, baseRevision: NEW_HEAD, op: update("x") });
    expect(calls[0]?.input.idempotencyKey).not.toBe(calls[1]?.input.idempotencyKey);
  });

  it("forgets the key after a definitive server answer", async () => {
    const { calls, deps } = recorder();
    const input = { kbId: KB, baseRevision: HEAD, op: update("x") };
    const first = await runEditorOp(deps, initialEditorMemory(), input);
    expect(first.memory).toEqual(initialEditorMemory());
    await runEditorOp(deps, first.memory, input);
    expect(calls[0]?.input.idempotencyKey).not.toBe(calls[1]?.input.idempotencyKey);
  });

  it("conflict retains local input and reports the actual new head; no automatic retry", async () => {
    const { calls, deps } = recorder(() =>
      orpcError("CONFLICT", { code: "CONFLICT", details: { headSha: PR_HEAD, proposalNumber: 4 } }),
    );
    const out = await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: update("my local text"),
    });
    expect(calls).toHaveLength(1);
    expect(out.outcome).toEqual({ kind: "conflict", headSha: PR_HEAD, proposalNumber: 4 });
    // runEditorOp never touches the draft; the caller keeps its text.
    expect(out.markdown).toBe("my local text");
  });

  it("conflict without readable details reports an unknown head (never guesses)", async () => {
    const { deps } = recorder(() => orpcError("CONFLICT"));
    const out = await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: update("x"),
    });
    expect(out.outcome).toEqual({ kind: "conflict", headSha: null, proposalNumber: null });
  });

  it("proposed result is a proposal, never shown as a main update", async () => {
    const pr = {
      number: 7,
      title: "Edit",
      sourceBranch: "kb/pr/7",
      targetBranch: "main" as const,
      baseSha: HEAD,
      headSha: PR_HEAD,
      targetSha: HEAD,
      status: "OPEN" as const,
      authorActorKey: "user:x",
      version: 1,
      mergeCommitSha: null,
    };
    const { deps } = recorder(() =>
      applied({ kind: "proposed", commitSha: PR_HEAD, proposal: pr, indexJobId: null }),
    );
    const out = await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: update("x"),
    });
    expect(out.outcome).toEqual({
      kind: "proposed",
      proposalNumber: 7,
      proposalHead: PR_HEAD,
      created: true,
    });
    // A later edit to the same proposal reads as an update.
    const again = settleOutcome({
      ...applied({ kind: "proposed", commitSha: PR_HEAD, proposal: pr, indexJobId: null }),
      proposal: { ...pr, version: 2 },
    });
    expect(again).toMatchObject({ kind: "proposed", created: false });
    // The next edit continues the proposal branch, main head stays untouched.
    expect(out.nextBaseRevision).toBe(PR_HEAD);
  });

  it("applied shows commit and index job; noop is distinct and keeps the base", async () => {
    const a = settleOutcome(applied());
    expect(a).toEqual({
      kind: "applied",
      commitSha: NEW_HEAD,
      indexJobId: "00000000-0000-4000-8000-0000000000bb",
    });
    const noop = settleOutcome(applied({ kind: "noop", commitSha: HEAD, indexJobId: null }));
    expect(noop).toEqual({ kind: "noop", commitSha: HEAD });
  });

  it("delete sends confirm DELETE with base revision", async () => {
    const { calls, deps } = recorder();
    await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: { kind: "delete", path: "notes/a.md" },
    });
    expect(calls[0]).toEqual({
      op: "delete",
      input: {
        kbId: KB,
        baseRevision: HEAD,
        path: "notes/a.md",
        confirm: "DELETE",
        idempotencyKey: "key-0000000000000001",
      },
    });
  });

  it("stages markdown larger than 128 KiB through the upload service", async () => {
    const big = "a".repeat(INLINE_MARKDOWN_MAX_BYTES + 1);
    const { calls, deps } = recorder((op, input) => {
      if (op === "uploadBegin")
        return {
          operationId: OP_ID,
          uploadId: UPLOAD,
          offset: 0,
          expiresAt: "2026-09-27T00:00:00Z",
          maxChunkBytes: 65536,
        };
      if (op === "uploadWrite") {
        const bytes = atob(String(input.bytesBase64)).length;
        return { uploadId: UPLOAD, offset: Number(input.offset) + bytes };
      }
      if (op === "uploadFinish") return { uploadId: UPLOAD, state: "READY" };
      return applied();
    });
    await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: { kind: "create", path: "big.md", markdown: big },
    });
    expect(calls.map((c) => c.op)).toEqual([
      "uploadBegin",
      "uploadWrite",
      "uploadWrite",
      "uploadWrite",
      "uploadFinish",
      "create",
    ]);
    expect(calls[0]?.input).toMatchObject({
      kind: "markdown",
      size: INLINE_MARKDOWN_MAX_BYTES + 1,
      contentHash: `sha256:${"f".repeat(64)}`,
      mime: "text/markdown",
    });
    expect(calls.at(-1)?.input.content).toEqual({ uploadId: UPLOAD });
  });

  it("exactly 128 KiB stays inline", async () => {
    const { calls, deps } = recorder();
    await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: update("a".repeat(INLINE_MARKDOWN_MAX_BYTES)),
    });
    expect(calls.map((c) => c.op)).toEqual(["update"]);
  });

  it("refuses markdown above 2 MiB before any request", async () => {
    const { calls, deps } = recorder();
    const out = await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: update("a".repeat(2 * 1024 * 1024 + 1)),
    });
    expect(out.outcome).toEqual({ kind: "error", reason: "tooLarge" });
    expect(calls).toHaveLength(0);
  });
});

describe("error classification", () => {
  it("access loss is NOT_FOUND or FORBIDDEN", () => {
    expect(isAccessLoss(orpcError("NOT_FOUND"))).toBe(true);
    expect(isAccessLoss(orpcError("FORBIDDEN"))).toBe(true);
    expect(isAccessLoss(orpcError("CONFLICT"))).toBe(false);
    expect(isAccessLoss(new TypeError("x"))).toBe(false);
  });
  it("a missing path at a readable revision is the document's state, not access loss", () => {
    const missing = orpcError("NOT_FOUND", {
      code: "NOT_FOUND",
      details: { reason: "PATH_NOT_FOUND" },
    });
    expect(isPathNotFound(missing)).toBe(true);
    expect(isAccessLoss(missing)).toBe(false);
    expect(isPathNotFound(orpcError("NOT_FOUND", { code: "NOT_FOUND" }))).toBe(false);
    expect(isPathNotFound(orpcError("FORBIDDEN", { details: { reason: "PATH_NOT_FOUND" } }))).toBe(
      false,
    );
  });
  it("maps idempotency mismatch and bad request to non-retryable errors", () => {
    expect(describeEditorError(orpcError("IDEMPOTENCY_MISMATCH"))).toEqual({
      kind: "error",
      reason: "rejected",
    });
    expect(describeEditorError(orpcError("TOO_MANY_REQUESTS"))).toEqual({ kind: "retryable" });
    expect(describeEditorError(orpcError("NOT_FOUND"))).toEqual({ kind: "error", reason: "gone" });
  });
});

describe("clearKbPrivateQueries", () => {
  it("removes every cached private query for that KB and keeps other KBs", () => {
    const qc = new QueryClient();
    const docKey = (kbId: string) => [
      ["documents", "get"],
      { type: "query", input: { kbId, path: "a.md" } },
    ];
    qc.setQueryData(docKey(KB), { markdown: "secret" });
    qc.setQueryData([["search", "hybrid"], { type: "query", input: { kbId: KB, query: "q" } }], {
      results: [],
    });
    qc.setQueryData([["kbs", "get"], { type: "query", input: { kbId: KB } }], { kb: {} });
    qc.setQueryData(docKey(OTHER_KB), { markdown: "other" });
    clearKbPrivateQueries(qc, KB);
    expect(qc.getQueryData(docKey(KB))).toBeUndefined();
    expect(
      qc.getQueryData([["search", "hybrid"], { type: "query", input: { kbId: KB, query: "q" } }]),
    ).toBeUndefined();
    expect(
      qc.getQueryData([["kbs", "get"], { type: "query", input: { kbId: KB } }]),
    ).toBeUndefined();
    expect(qc.getQueryData(docKey(OTHER_KB))).toEqual({ markdown: "other" });
  });
});

describe("recheckKbAccess (clear only on actual access loss)", () => {
  const kbGetKey = (kbId: string) => [["kbs", "get"], { type: "query", input: { kbId } }];
  const docKey = (kbId: string) => [
    ["documents", "get"],
    { type: "query", input: { kbId, path: "a.md" } },
  ];
  const listKey = [["kbs", "list"], { type: "infinite", input: {} }];
  function seeded() {
    const qc = new QueryClient();
    qc.setQueryData(kbGetKey(KB), { kb: { id: KB, isOwner: true, capabilities: ["manage"] } });
    qc.setQueryData(docKey(KB), { markdown: "cached body" });
    qc.setQueryData(docKey(OTHER_KB), { markdown: "other" });
    qc.setQueryData(listKey, { pages: [] });
    return qc;
  }
  const options = (queryFn: () => Promise<unknown>) => ({ queryKey: kbGetKey(KB), queryFn });

  it("a manager denied one owner-only action keeps the KB view and cache; controls re-derive", async () => {
    const qc = seeded();
    const fresh = { kb: { id: KB, isOwner: false, capabilities: ["read", "manage"] } };
    const result = await recheckKbAccess(
      qc,
      KB,
      options(async () => fresh),
    );
    expect(result).toBe("kept");
    expect(qc.getQueryData(docKey(KB))).toEqual({ markdown: "cached body" });
    // The refreshed permission check replaces the stale owner flag.
    expect(qc.getQueryData(kbGetKey(KB))).toEqual(fresh);
    expect(qc.getQueryState(kbGetKey(KB))?.status).toBe("success");
  });

  it.each([
    { old: "success", scoped: false },
    { old: "denial", scoped: false },
    { old: "success", scoped: true },
    { old: "denial", scoped: true },
  ])(
    "cancels a pre-denial in-flight $old before the fresh admission (actor-scoped=$scoped)",
    async ({ old, scoped }) => {
      const qc = seeded();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const earlier = qc
        .fetchQuery(
          options(async () => {
            await gate;
            if (old === "denial") throw orpcError("NOT_FOUND");
            return { kb: { id: KB, isOwner: true } };
          }),
        )
        .catch(() => undefined);
      const fresh = { kb: { id: KB, isOwner: false } };
      const result = await recheckKbAccess(
        qc,
        KB,
        options(async () => {
          if (old === "success") throw orpcError("NOT_FOUND");
          return fresh;
        }),
        scoped ? { key: "user:current", isCurrent: () => true } : undefined,
      );
      expect(result).toBe(old === "success" ? "lost" : "kept");
      release();
      await earlier;
      expect(qc.getQueryData(docKey(KB))).toEqual(
        old === "success" ? undefined : { markdown: "cached body" },
      );
      expect(qc.getQueryData(kbGetKey(KB))).toEqual(old === "success" ? undefined : fresh);
      qc.clear();
    },
  );

  it("a transient failure of the re-check is not access loss: nothing is cleared", async () => {
    const qc = seeded();
    const result = await recheckKbAccess(
      qc,
      KB,
      options(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    expect(result).toBe("kept");
    expect(qc.getQueryData(docKey(KB))).toEqual({ markdown: "cached body" });
  });

  it.each(["NOT_FOUND", "FORBIDDEN"])(
    "the re-check answering %s is actual loss: every private query for that KB is cleared",
    async (code) => {
      const qc = seeded();
      const result = await recheckKbAccess(
        qc,
        KB,
        options(async () => {
          throw orpcError(code);
        }),
      );
      expect(result).toBe("lost");
      expect(qc.getQueryData(docKey(KB))).toBeUndefined();
      // kbs.get keeps its error (so the page shows "unavailable") but no data.
      expect(qc.getQueryData(kbGetKey(KB))).toBeUndefined();
      expect(qc.getQueryState(kbGetKey(KB))?.status).toBe("error");
      expect(qc.getQueryData(docKey(OTHER_KB))).toEqual({ markdown: "other" });
      expect(qc.getQueryState(listKey)?.isInvalidated).toBe(true);
    },
  );

  it("an already changed actor cannot start an access check or retire caches", async () => {
    const qc = seeded();
    let reads = 0;
    await recheckKbAccess(
      qc,
      KB,
      options(async () => {
        reads++;
        throw orpcError("NOT_FOUND");
      }),
      { key: "user:previous", isCurrent: () => false },
    );
    expect(reads).toBe(0);
    expect(qc.getQueryData(docKey(KB))).toEqual({ markdown: "cached body" });
    expect(qc.getQueryState(kbGetKey(KB))?.status).toBe("success");
    qc.clear();
  });

  it.each(["success", "NOT_FOUND", "FORBIDDEN"])(
    "an actor change during a fresh %s check cannot publish into the successor's caches",
    async (result) => {
      const qc = seeded();
      let current = true;
      let entered!: () => void;
      const reading = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const actor = { key: "user:previous", isCurrent: () => current };
      const check = recheckKbAccess(
        qc,
        KB,
        options(async () => {
          entered();
          await gate;
          if (result !== "success") throw orpcError(result);
          return { kb: { id: KB, capabilities: ["read"] } };
        }),
        actor,
      );
      await reading;
      current = false;
      const next = { kb: { id: KB, capabilities: ["read", "propose"] } };
      qc.setQueryData(kbGetKey(KB), next);
      qc.setQueryData([...kbGetKey(KB), "user:next"], next);
      release();
      expect(await check).toBe("kept");
      expect(qc.getQueryData(kbGetKey(KB))).toEqual(next);
      expect(qc.getQueryData([...kbGetKey(KB), "user:next"])).toEqual(next);
      expect(qc.getQueryData(docKey(KB))).toEqual({ markdown: "cached body" });
      expect(qc.getQueryState(listKey)?.isInvalidated).toBe(false);
      qc.clear();
    },
  );

  it.each(["readable", "NOT_FOUND", "FORBIDDEN"])(
    "a current actor's %s check updates shared and actor-scoped observers",
    async (result) => {
      const qc = seeded();
      const actor = { key: "user:current", isCurrent: () => true };
      const fresh = { kb: { id: KB, capabilities: ["read"] } };
      const verdict = await recheckKbAccess(
        qc,
        KB,
        options(async () => {
          if (result !== "readable") throw orpcError(result);
          return fresh;
        }),
        actor,
      );
      expect(verdict).toBe(result === "readable" ? "kept" : "lost");
      for (const key of [kbGetKey(KB), [...kbGetKey(KB), actor.key]]) {
        expect(qc.getQueryData(key)).toEqual(result === "readable" ? fresh : undefined);
        expect(qc.getQueryState(key)?.status).toBe(result === "readable" ? "success" : "error");
      }
      expect(qc.getQueryData(docKey(KB))).toEqual(
        result === "readable" ? { markdown: "cached body" } : undefined,
      );
      expect(qc.getQueryData(docKey(OTHER_KB))).toEqual({ markdown: "other" });
      qc.clear();
    },
  );
});

describe("staged attempt recovery", () => {
  const big = "a".repeat(INLINE_MARKDOWN_MAX_BYTES + 1);
  const input = { kbId: KB, baseRevision: HEAD, op: update(big) };
  function staged(fault: string) {
    let failed = false;
    let offset = 0;
    let ready = false;
    const { calls, deps } = recorder((op, values) => {
      let result: unknown;
      if (op === "uploadBegin") result = { uploadId: UPLOAD, offset: 0, maxChunkBytes: 65536 };
      else if (op === "uploadWrite") {
        if (ready) return orpcError("CONFLICT");
        // Real write accepts only contiguous new ranges or byte-identical replays.
        const end = Number(values.offset) + atob(String(values.bytesBase64)).length;
        offset = Math.max(offset, end);
        result = { offset };
      } else if (op === "uploadFinish") {
        ready = true;
        result = { state: "READY" };
      } else result = applied();
      if (op === fault && !failed) {
        failed = true;
        return new TypeError("Lost acknowledgement");
      }
      return result;
    });
    return { calls, deps };
  }
  it.each(["uploadBegin", "uploadWrite", "uploadFinish", "update"])(
    "replays after lost %s acknowledgement",
    async (fault) => {
      const { calls, deps } = staged(fault);
      const first = await runEditorOp(deps, initialEditorMemory(), input);
      expect(first.outcome.kind).toBe("retryable");
      const boundary = calls.length;
      const retry = await runEditorOp(deps, first.memory, input);
      expect(retry.outcome.kind).toBe("applied");
      expect(calls.filter((c) => c.op === fault)[0]?.input).toEqual(
        calls.filter((c) => c.op === fault)[1]?.input,
      );
      if (fault === "uploadFinish") expect(calls[boundary]?.op).toBe("uploadFinish");
      if (fault === "update") expect(calls.slice(boundary).map((c) => c.op)).toEqual(["update"]);
      expect(retry.memory).toEqual(initialEditorMemory());
    },
  );
  it.each(["kb", "operation", "path", "text", "base"])(
    "changed %s cannot reuse another payload's prepared upload",
    async (field) => {
      const { calls, deps } = staged("update");
      const first = await runEditorOp(deps, initialEditorMemory(), input);
      const changed = {
        kbId: field === "kb" ? OTHER_KB : KB,
        baseRevision: field === "base" ? NEW_HEAD : HEAD,
        op: {
          markdown: field === "text" ? `${big}b` : big,
          kind: field === "operation" ? ("create" as const) : ("update" as const),
          path: field === "path" ? "b.md" : "notes/a.md",
        },
      };
      const boundary = calls.length;
      await runEditorOp(deps, first.memory, changed);
      expect(calls[boundary]?.op).toBe("uploadBegin");
      expect(calls[boundary]?.input.idempotencyKey).not.toBe(calls[0]?.input.idempotencyKey);
    },
  );
  it("a claimed/consumed upload conflict never restages or implies a successful receipt", async () => {
    const { calls, deps } = staged("update");
    const first = await runEditorOp(deps, initialEditorMemory(), input);
    deps.update = async () => {
      throw orpcError("CONFLICT");
    };
    const boundary = calls.length;
    const conflict = await runEditorOp(deps, first.memory, input);
    expect(conflict.outcome).toEqual({ kind: "conflict", headSha: null, proposalNumber: null });
    expect(conflict.memory).toEqual(first.memory);
    expect(calls).toHaveLength(boundary);
    deps.update = async () => applied();
    expect((await runEditorOp(deps, conflict.memory, input)).outcome.kind).toBe("applied");
  });
  it("expiry rejects preparation and discards its key instead of guessing a receipt", async () => {
    const { deps } = staged("uploadFinish");
    const first = await runEditorOp(deps, initialEditorMemory(), input);
    deps.uploadFinish = async () => {
      throw orpcError("BAD_REQUEST");
    };
    const expired = await runEditorOp(deps, first.memory, input);
    expect(expired.outcome).toEqual({ kind: "error", reason: "rejected" });
    expect(expired.memory).toEqual(initialEditorMemory());
  });
});

describe("actual private query key inventory", () => {
  it("evicts query/infinite consumers including mirror, keeping account queries and other KBs", () => {
    const keys = (kbId: string): readonly (readonly unknown[])[] => [
      orpc.kbs.get.queryOptions({ input: { kbId } }).queryKey,
      orpc.kbs.shareList.infiniteOptions({
        input: (cursor: string | null) => ({ kbId, cursor, limit: 20 }),
        initialPageParam: null,
        getNextPageParam: (page) => page?.nextCursor,
      }).queryKey,
      orpc.documents.get.queryOptions({ input: { kbId, path: "a.md" } }).queryKey,
      orpc.documents.list.infiniteOptions({
        input: (cursor: string | null) => ({ kbId, cursor, limit: 20 }),
        initialPageParam: null,
        getNextPageParam: (page) => page?.nextCursor,
      }).queryKey,
      orpc.search.hybrid.queryOptions({ input: { kbId, query: "q" } }).queryKey,
      orpc.search.structured.infiniteOptions({
        input: (cursor: string | null) => ({ kbId, type: "note", cursor, limit: 20 }),
        initialPageParam: null,
        getNextPageParam: (page) => page?.nextCursor,
      }).queryKey,
      orpc.kbIndex.status.queryOptions({ input: { kbId } }).queryKey,
      orpc.pullRequests.list.infiniteOptions({
        input: (cursor: string | null) => ({ kbId, cursor, limit: 20 }),
        initialPageParam: null,
        getNextPageParam: (page) => page?.nextCursor,
      }).queryKey,
      orpc.kbMirror.status.queryOptions({ input: { kbId } }).queryKey,
    ];
    const qc = new QueryClient();
    const own = keys(KB),
      other = keys(OTHER_KB);
    const account: readonly unknown[] = orpc.embeddingProviders.listMine.queryOptions({
      input: {},
    }).queryKey;
    for (const key of [...own, ...other, account]) qc.setQueryData(key, "private data");
    clearKbPrivateQueries(qc, KB);
    for (const key of own) expect(qc.getQueryData(key)).toBeUndefined();
    for (const key of [...other, account]) expect(qc.getQueryData(key)).toBe("private data");
  });
});

describe("image staging (R3-W7)", () => {
  const png = (n: number) => ({
    name: "Screen Shot 1.PNG",
    type: "image/png",
    bytes: new Uint8Array(n),
  });
  function assetDeps(respond: (op: string, input: Record<string, unknown>) => unknown) {
    const { calls, deps } = recorder(respond);
    const sleep = async () => {};
    return { calls, deps: { ...deps, sleep } };
  }
  const ok = (op: string, input: Record<string, unknown>) => {
    if (op === "uploadBegin") return { uploadId: UPLOAD, offset: 0, maxChunkBytes: 4 };
    if (op === "uploadWrite")
      return {
        offset: (input.offset as number) + Math.min(4, 10 - (input.offset as number)),
      };
    if (op === "uploadFinish") return {};
    throw new Error(`unexpected ${op}`);
  };

  it("derives a portable, collision-free asset path and root-relative Markdown", () => {
    expect(imageAssetPath("Screen Shot 1.PNG", "image/png", "abcdef0123")).toBe(
      "assets/screen-shot-1-abcdef01.png",
    );
    expect(imageAssetPath("....jpeg", "image/jpeg", "0".repeat(64))).toBe(
      "assets/image-00000000.jpg",
    );
    expect(imageMarkdown("a]b[c\\d.png", "assets/x.png")).toBe("![a b c d](/assets/x.png)");
  });

  it("only stages the bytes as an asset upload: nothing is committed before Save", async () => {
    const { calls, deps } = assetDeps(ok);
    const progress: number[] = [];
    const run = await runImageStage(deps, {
      kbId: KB,
      file: png(10),
      onProgress: (sent) => progress.push(sent),
    });
    expect(calls.map((c) => c.op)).toEqual([
      "uploadBegin",
      "uploadWrite",
      "uploadWrite",
      "uploadWrite",
      "uploadFinish",
    ]);
    expect(calls[0]?.input).toMatchObject({ kind: "asset", mime: "image/png", size: 10 });
    expect(progress).toEqual([0, 4, 8, 10]);
    expect(run).toEqual({
      ok: true,
      image: {
        path: `assets/screen-shot-1-${"f".repeat(8)}.png`,
        uploadId: UPLOAD,
        hash: `sha256:${"f".repeat(64)}`,
        size: 10,
        mime: "image/png",
      },
      markdown: `![Screen Shot 1](/assets/screen-shot-1-${"f".repeat(8)}.png)`,
    });
  });

  it("refuses unsupported types (SVG) and oversized files before any call", async () => {
    const { calls, deps } = assetDeps(ok);
    expect(
      await runImageStage(deps, {
        kbId: KB,
        file: { name: "x.svg", type: "image/svg+xml", bytes: new Uint8Array(3) },
      }),
    ).toEqual({ ok: false, error: "type" });
    expect(await runImageStage(deps, { kbId: KB, file: png(25 * 1024 * 1024 + 1) })).toEqual({
      ok: false,
      error: "tooLarge",
    });
    expect(calls).toEqual([]);
  });

  it("maps a refused upload to a specific error and forgets it", async () => {
    const staged: StagedImages = new Map();
    const rejected = assetDeps((op, input) =>
      op === "uploadFinish" ? orpcError("BAD_REQUEST") : ok(op, input),
    );
    expect(await runImageStage(rejected.deps, { kbId: KB, file: png(10), staged })).toEqual({
      ok: false,
      error: "rejected",
    });
    expect(staged.size).toBe(0);
  });

  it("resumes an interrupted transfer of the same image instead of restarting", async () => {
    const staged: StagedImages = new Map();
    let lose = true;
    const { calls, deps } = assetDeps((op, input) => {
      if (op === "uploadWrite" && input.offset === 4 && lose) {
        lose = false;
        return new TypeError("network");
      }
      return ok(op, input);
    });
    expect(await runImageStage(deps, { kbId: KB, file: png(10), staged })).toEqual({
      ok: false,
      error: "retryable",
    });
    expect(staged.size).toBe(1);
    const second = await runImageStage(deps, { kbId: KB, file: png(10), staged });
    expect(second.ok).toBe(true);
    expect(staged.size).toBe(0);
    expect(calls.filter((c) => c.op === "uploadBegin")).toHaveLength(1);
    expect(calls.filter((c) => c.op === "uploadWrite").map((c) => c.input.offset)).toEqual([
      0, 4, 4, 8,
    ]);
  });
});

// Base64-encoding up to 75 MiB is slow on a loaded CI runner.
describe("image upload rate budget (R3-W7)", { timeout: 60_000 }, () => {
  const CHUNK = 196_608;
  const MAX = 25 * 1024 * 1024;
  const limited = (retryAfterSeconds: number) =>
    Object.assign(new Error("TOO_MANY_REQUESTS"), {
      code: "TOO_MANY_REQUESTS",
      data: { retryAfterSeconds },
      status: 429,
    });
  /**
   * The server's kb-upload budget: 120 requests per minute per user, shared by
   * begin, write and finish. A refused request is not
   * charged; the window resets when the client waits retryAfterSeconds.
   */
  function server() {
    const calls: { op: string; input: Record<string, unknown> }[] = [];
    const sleeps: number[] = [];
    const uploads = new Map<string, { size: number; offset: number }>();
    let used = 0;
    let n = 0;
    const charge = () => {
      if (used >= 120) throw limited(60);
      used += 1;
    };
    const deps = {
      uploadBegin: async (input: { size: number }) => {
        charge();
        const uploadId = `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
        uploads.set(uploadId, { size: input.size, offset: 0 });
        calls.push({ op: "uploadBegin", input });
        return { uploadId, offset: 0, maxChunkBytes: CHUNK };
      },
      uploadWrite: async (input: { uploadId: string; offset: number; bytesBase64: string }) => {
        charge();
        const upload = uploads.get(input.uploadId)!;
        expect(input.offset).toBe(upload.offset);
        upload.offset = Math.min(upload.size, upload.offset + CHUNK);
        calls.push({ op: "uploadWrite", input: { offset: input.offset } });
        return { offset: upload.offset };
      },
      uploadFinish: async (input: { uploadId: string }) => {
        charge();
        calls.push({ op: "uploadFinish", input });
        return {};
      },
      newKey: () => `key-${String(++n).padStart(16, "0")}`,
      sha256Hex: async (bytes: Uint8Array) => (bytes[0] ?? 0).toString(16).padStart(64, "0"),
      sleep: async (ms: number) => {
        sleeps.push(ms);
        used = 0;
      },
    };
    return { calls, sleeps, deps: deps as unknown as Parameters<typeof runImageStage>[0] };
  }
  const image = (size: number, first = 1) => {
    const bytes = new Uint8Array(size);
    bytes[0] = first;
    return { name: "big.png", type: "image/png", bytes };
  };

  it("uploads a 25 MiB image past the 120/min budget by waiting, never restarting", async () => {
    const { calls, sleeps, deps } = server();
    const waits: number[] = [];
    const run = await runImageStage(deps, {
      kbId: KB,
      file: image(MAX),
      onWait: (seconds) => waits.push(seconds),
    });
    expect(run.ok).toBe(true);
    const writes = calls.filter((c) => c.op === "uploadWrite").map((c) => c.input.offset);
    expect(writes.length).toBe(Math.ceil(MAX / CHUNK)); // 134: each chunk sent once
    expect(writes).toEqual(writes.map((_, i) => i * CHUNK));
    expect(calls.filter((c) => c.op === "uploadBegin")).toHaveLength(1);
    expect(sleeps).toEqual([60_000]);
    expect(waits).toEqual([60]);
  });

  it("shares the budget across a batch of images", async () => {
    const { calls, sleeps, deps } = server();
    for (const first of [1, 2, 3]) {
      const run = await runImageStage(deps, {
        kbId: KB,
        file: image(MAX, first),
      });
      expect(run.ok).toBe(true);
    }
    expect(calls.filter((c) => c.op === "uploadFinish")).toHaveLength(3);
    expect(calls.filter((c) => c.op === "uploadBegin")).toHaveLength(3);
    // 3 × (1 + 134 + 1) = 408 budgeted requests need three waits.
    expect(sleeps).toEqual([60_000, 60_000, 60_000]);
  });

  it("gives up after repeated refusals and resumes the staged upload on the next insert", async () => {
    const { calls, deps } = server();
    let refuse = false;
    const write = deps.uploadWrite;
    const flaky = {
      ...deps,
      uploadWrite: async (input: Parameters<typeof write>[0]) => {
        if (refuse) throw limited(60);
        const out = await write(input);
        if (input.offset === 10 * CHUNK) refuse = true;
        return out;
      },
    };
    const staged: StagedImages = new Map();
    const first = await runImageStage(flaky, {
      kbId: KB,
      file: image(MAX),
      staged,
    });
    expect(first).toEqual({ ok: false, error: "retryable" });
    expect(staged.size).toBe(1);
    expect(UPLOAD_BUDGET_MAX_WAITS).toBeGreaterThan(0);
    refuse = false;
    const second = await runImageStage(flaky, {
      kbId: KB,
      file: image(MAX),
      staged,
    });
    expect(second.ok).toBe(true);
    expect(staged.size).toBe(0);
    const offsets = calls.filter((c) => c.op === "uploadWrite").map((c) => c.input.offset);
    // Chunks 0..10 once, then the resume continues at chunk 11: nothing from zero.
    expect(offsets.slice(0, 12)).toEqual(Array.from({ length: 12 }, (_, i) => i * CHUNK));
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(calls.filter((c) => c.op === "uploadBegin")).toHaveLength(1);
  });
});

describe("staged images in the save payload (R3-W7)", () => {
  const withAssets = (
    markdown: string,
    assets: { path: string; uploadId: string }[],
  ): EditorOp => ({ kind: "update", path: "notes/a.md", markdown, assets });
  const image = (n: number) => ({
    path: `assets/img-${String(n).padStart(8, "0")}.png`,
    uploadId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  });

  it("only images the draft still links are sent", () => {
    const staged = [image(1), image(2), image(3)];
    const draft = `# T\n\n![a](/${image(1).path})\n\n![c](/${image(3).path})\n`;
    expect(linkedStagedImages(draft, staged)).toEqual([image(1), image(3)]);
    expect(linkedStagedImages("# T\n", staged)).toEqual([]);
  });

  it("sends the staged assets with the document in one request", async () => {
    const { calls, deps } = recorder();
    await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: withAssets("![a](/assets/img-00000001.png)", [image(1)]),
    });
    expect(calls.map((c) => c.op)).toEqual(["update"]);
    expect(calls[0]?.input).toMatchObject({ assets: [image(1)] });
  });

  it("sends no assets field without staged images", async () => {
    const { calls, deps } = recorder();
    await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: withAssets("x", []),
    });
    expect(calls[0]?.input).not.toHaveProperty("assets");
  });

  it(`refuses more than ${DOCUMENT_STAGED_ASSETS_MAX} images before any request`, async () => {
    const { calls, deps } = recorder();
    const assets = Array.from({ length: DOCUMENT_STAGED_ASSETS_MAX + 1 }, (_, i) => image(i + 1));
    const out = await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: withAssets("x", assets),
    });
    expect(out.outcome).toEqual({ kind: "error", reason: "tooManyImages" });
    expect(calls).toEqual([]);
    const seven = await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: withAssets("x", assets.slice(0, DOCUMENT_STAGED_ASSETS_MAX)),
    });
    expect(seven.outcome.kind).toBe("applied");
  });

  it("a changed image set is a new payload with a new key", async () => {
    let fail = true;
    const { calls, deps } = recorder(() => {
      if (fail) {
        fail = false;
        return new TypeError("network");
      }
      return applied();
    });
    const first = await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: withAssets("x", [image(1)]),
    });
    await runEditorOp(deps, first.memory, {
      kbId: KB,
      baseRevision: HEAD,
      op: withAssets("x", [image(2)]),
    });
    expect(calls[1]?.input.idempotencyKey).not.toBe(calls[0]?.input.idempotencyKey);
  });

  it("maps an expired staged upload to its own message", () => {
    expect(describeEditorError(orpcError("UPLOAD_EXPIRED"))).toEqual({
      kind: "error",
      reason: "uploadExpired",
    });
  });
});

describe("PR mode saves (R3-W6)", () => {
  it("saves against current main with the pull request's number", async () => {
    const { calls, deps } = recorder();
    await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: update("resolved"),
      proposalNumber: 4,
    });
    expect(calls[0]?.input).toMatchObject({
      baseRevision: HEAD,
      proposalNumber: 4,
      content: { markdown: "resolved" },
    });
  });

  it("a typed PROPOSAL_CONFLICT reaches the editor exactly as the documents router sends it", () => {
    const outcome = describeEditorError(routerConflict(domainProposalConflict()));
    expect(outcome).toEqual({
      kind: "conflict",
      // The proposal head the caller may read; main is what the next save targets.
      headSha: PR_HEAD,
      proposalNumber: 4,
      proposalConflict: {
        mainSha: HEAD,
        paths: [
          { path: "a.md", kind: "document", baseSha: BASE, theirsSha: HEAD, yoursSha: PR_HEAD },
          {
            path: "assets/x.png",
            kind: "asset",
            baseSha: BASE,
            theirsSha: HEAD,
            yoursSha: PR_HEAD,
          },
        ],
      },
    });
  });

  it("a plain conflict keeps its head and proposal; unreadable details guess nothing", () => {
    expect(
      describeEditorError(
        routerConflict({ headSha: PR_HEAD, proposalNumber: 4, message: "stale proposal read" }),
      ),
    ).toEqual({ kind: "conflict", headSha: PR_HEAD, proposalNumber: 4 });
    expect(describeEditorError(routerConflict({ headSha: HEAD, proposalNumber: null }))).toEqual({
      kind: "conflict",
      headSha: HEAD,
      proposalNumber: null,
    });
    // A malformed PROPOSAL_CONFLICT is refused by the router mapping: empty details.
    const broken = { ...domainProposalConflict(), proposalHeadSha: "nope" };
    expect(describeEditorError(routerConflict(broken))).toEqual({
      kind: "conflict",
      headSha: null,
      proposalNumber: null,
    });
  });
});

describe("staged image lifecycle across saves (R3-W7)", () => {
  const img = (n: number): EditorStagedImage => ({
    path: `assets/img-${String(n).padStart(8, "0")}.png`,
    uploadId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    hash: `sha256:${String(n).repeat(64).slice(0, 64)}`,
    size: 3,
    mime: "image/png",
    objectUrl: `blob:local/${n}`,
  });
  const link = (image: EditorStagedImage) => `![x](/${image.path})`;

  it("an image unlinked at Save and re-linked while it is pending stays staged for the next save", () => {
    const [a, b] = [img(1), img(2)];
    // Save 1 sends only A: B is not linked when it starts.
    const one = beginImageSave([a, b], link(a), "save-1");
    expect(one.sent.map((i) => i.path)).toEqual([a.path]);
    // The user re-links B while save 1 is in flight; save 1 succeeds.
    const settled = settleImageSave(one.images, "save-1", true);
    expect(settled.retired.map((i) => i.path)).toEqual([a.path]);
    expect(settled.images).toEqual([b]);
    // The next save carries B's upload with its re-linked text.
    const two = beginImageSave(settled.images, `${link(a)}\n\n${link(b)}`, "save-2");
    expect(two.sent.map((i) => i.uploadId)).toEqual([b.uploadId]);
  });

  it("a failed save returns its images to staging; another save's images are untouched", () => {
    const [a, b] = [img(1), img(2)];
    const one = beginImageSave([a, b], `${link(a)}${link(b)}`, "save-1");
    expect(one.images.every((i) => i.sentWith === "save-1")).toBe(true);
    const failed = settleImageSave(one.images, "save-1", false);
    expect(failed.retired).toEqual([]);
    expect(failed.images).toEqual([a, b]);
    // Only images of the settling save are retired.
    const other = settleImageSave(one.images, "save-9", true);
    expect(other.retired).toEqual([]);
    expect(other.images).toEqual(one.images);
  });

  it("an image already sent with a pending save is not sent twice", () => {
    const a = img(1);
    const one = beginImageSave([a], link(a), "save-1");
    expect(beginImageSave(one.images, link(a), "save-2").sent).toEqual([]);
  });

  it("after a PR-mode save the preview reads the proposal head with the committed image", () => {
    const opened = { rev: HEAD, assets: [] };
    const committedImage = { path: img(1).path, hash: img(1).hash, size: 3, mime: "image/png" };
    const committed = { rev: PR_HEAD, assets: [committedImage] };
    // PR mode pins its opening revision forever: the saved head wins.
    expect(previewAfterSaves(opened, committed)).toEqual({
      rev: PR_HEAD,
      assets: [committedImage],
    });
    // Once the page's own read lists the image, it is used as is.
    const reread = { rev: NEW_HEAD, assets: [committedImage] };
    expect(previewAfterSaves(reread, committed)).toBe(reread);
    expect(previewAfterSaves(opened, null)).toBe(opened);
  });
});

describe("PR-targeted writes name the head they read (R3-W6)", () => {
  const MAIN = HEAD;
  const PR = 9;
  const head = (n: number) => String(n + 3).repeat(40);
  /**
   * The server rule (`continueProposal`): a write naming the proposal must
   * name its current head, else CONFLICT with that head; each accepted write
   * resolves the recorded conflict of its path and moves the head.
   */
  function prServer(recorded: string[]) {
    let current = head(1);
    let n = 1;
    const pending = new Set(recorded);
    const calls: Record<string, unknown>[] = [];
    const write = async (input: Record<string, unknown>) => {
      calls.push(input);
      if (input.proposalNumber !== PR || input.proposalHeadSha !== current)
        throw new ORPCError("CONFLICT", {
          data: {
            code: "CONFLICT",
            details: browserConflictDetails({ headSha: current, proposalNumber: PR }) ?? {},
          },
        });
      pending.delete(String(input.path));
      current = head(++n);
      return applied({
        kind: "proposed",
        commitSha: current,
        indexJobId: null,
        proposal: {
          number: PR,
          title: "PR",
          sourceBranch: `pr/${PR}`,
          targetBranch: "main",
          baseSha: MAIN,
          headSha: current,
          targetSha: MAIN,
          status: pending.size > 0 ? "CONFLICT" : "OPEN",
          authorActorKey: "user:x",
          version: n,
          mergeCommitSha: null,
        },
      });
    };
    const { deps } = recorder();
    return {
      calls,
      pending,
      get head() {
        return current;
      },
      deps: { ...deps, create: write, update: write, remove: write } as EditorDeps,
    };
  }
  type Session = { base: string; proposal: EditedProposal };
  /** One editor session's write loop: send, then track the proposal as the hook does. */
  async function save(server: ReturnType<typeof prServer>, session: Session, path: string) {
    const run = await runEditorOp(server.deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: session.base,
      op: { kind: "update", path, markdown: `# ${path}\n` },
      proposalNumber: session.proposal?.number ?? null,
      proposalHeadSha: session.proposal?.headSha ?? null,
    });
    session.base = run.nextBaseRevision;
    session.proposal = proposalAfterSave(session.proposal, run.outcome);
    return run.outcome;
  }

  it("two editors of one PR: the second save is refused after the first lands", async () => {
    const server = prServer(["a.md"]);
    const first: Session = { base: MAIN, proposal: { number: PR, headSha: head(1) } };
    const second: Session = { base: MAIN, proposal: { number: PR, headSha: head(1) } };
    expect((await save(server, first, "a.md")).kind).toBe("proposed");
    const refused = await save(server, second, "a.md");
    // The stale draft is not applied; the editor learns the PR's new head.
    expect(refused).toEqual({ kind: "conflict", headSha: head(2), proposalNumber: PR });
    expect(server.head).toBe(head(2));
    expect(second.proposal).toEqual({ number: PR, headSha: head(1) });
    // Only an explicit adopt (after reading that head) continues it.
    if (refused.kind !== "conflict" || !refused.headSha) throw new Error("no head");
    second.base = refused.headSha;
    second.proposal = proposalAfterAdopt({ ...refused, headSha: refused.headSha });
    expect((await save(server, second, "a.md")).kind).toBe("proposed");
  });

  it("progressive resolution chains heads; a stale head for the next path is refused", async () => {
    const server = prServer(["a.md", "b.md"]);
    const session: Session = { base: MAIN, proposal: { number: PR, headSha: head(1) } };
    const stale: Session = { base: MAIN, proposal: { number: PR, headSha: head(1) } };
    expect((await save(server, session, "a.md")).kind).toBe("proposed");
    expect(session.proposal).toEqual({ number: PR, headSha: head(2) });
    expect(server.calls.at(-1)).toMatchObject({ baseRevision: MAIN, proposalHeadSha: head(1) });
    expect((await save(server, stale, "b.md")).kind).toBe("conflict");
    expect(server.pending.has("b.md")).toBe(true);
    expect((await save(server, session, "b.md")).kind).toBe("proposed");
    expect(server.calls.at(-1)).toMatchObject({ proposalNumber: PR, proposalHeadSha: head(2) });
    expect(server.pending.size).toBe(0);
  });

  it("a write without a proposal sends no proposal head", async () => {
    const { calls, deps } = recorder();
    await runEditorOp(deps, initialEditorMemory(), {
      kbId: KB,
      baseRevision: HEAD,
      op: update("x"),
      proposalHeadSha: PR_HEAD,
    });
    expect(calls[0]?.input).not.toHaveProperty("proposalHeadSha");
    expect(calls[0]?.input).not.toHaveProperty("proposalNumber");
  });
});

describe("each Save is an immutable record until its receipt resolves (R3-W7)", () => {
  const H0 = "a".repeat(40);
  const H1 = "b".repeat(40);
  const H2 = "c".repeat(40);
  const H3 = "d".repeat(40);
  const image: EditorStagedImage = {
    path: "assets/cat-12345678.png",
    uploadId: "00000000-0000-4000-8000-00000000cafe",
    hash: `sha256:${"c".repeat(64)}`,
    size: 3,
    mime: "image/png",
    objectUrl: "blob:local/cat",
  };
  const linked = (text: string) => `${text}\n\n![cat](/${image.path})`;
  /**
   * main with server idempotency (a key maps to one payload and its result)
   * and single-use uploads: a consumed upload under a new key is a headless
   * CONFLICT, as a reserved/consumed upload is on the real server.
   */
  function mainServer() {
    let head = H0;
    const heads = [H1, H2, "d".repeat(40)];
    const byKey = new Map<string, { payload: string; result: ApplyResultLike }>();
    const consumed = new Set<string>();
    const calls: Record<string, unknown>[] = [];
    let loseNext = false;
    const update = async (input: Record<string, unknown>) => {
      calls.push(input);
      const key = String(input.idempotencyKey);
      const payload = JSON.stringify(input);
      const known = byKey.get(key);
      if (known) {
        if (known.payload !== payload) throw orpcError("IDEMPOTENCY_MISMATCH");
        return known.result;
      }
      const uploads = ((input.assets as { uploadId: string }[] | undefined) ?? []).map(
        (a) => a.uploadId,
      );
      if (uploads.some((u) => consumed.has(u))) throw orpcError("CONFLICT");
      if (input.baseRevision !== head)
        throw orpcError("CONFLICT", {
          code: "CONFLICT",
          details: browserConflictDetails({ headSha: head, proposalNumber: null }),
        });
      for (const u of uploads) consumed.add(u);
      head = heads.shift()!;
      const result = applied({ commitSha: head, baseRevision: String(input.baseRevision) });
      byKey.set(key, { payload, result });
      if (loseNext) {
        loseNext = false;
        throw new TypeError("network: reply lost");
      }
      return result;
    };
    const { deps } = recorder();
    return {
      calls,
      loseReply: () => {
        loseNext = true;
      },
      deps: { ...deps, update: update as EditorDeps["update"] },
    };
  }
  const start = (): Parameters<typeof runSave>[1] => ({
    memory: initialEditorMemory(),
    images: [image],
    document: { exists: true, head: H0, path: "notes/a.md" },
    proposal: null,
  });
  const draft = (markdown: string) => ({
    kbId: KB,
    intent: { kind: "write" as const, markdown },
  });

  it("lost reply, then edit, then Save: the record resolves first; no consumed upload is resent", async () => {
    const server = mainServer();
    server.loseReply();
    const first = await runSave(server.deps, start(), draft(linked("v1")));
    expect(first.outcome).toEqual({ kind: "retryable" });
    expect(first.memory.request?.op).toMatchObject({ markdown: linked("v1") });
    expect(first.images[0]?.sentWith).toBe(first.memory.key);
    // The user keeps editing; the pending record is untouched.
    const second = await runSave(server.deps, first, draft(linked("v2")));
    expect(server.calls).toHaveLength(3);
    // 1) the exact record again (same key, bytes and upload), answered from its receipt;
    expect(server.calls[1]).toEqual(server.calls[0]);
    // 2) the edited draft as a new record on the head that record wrote, without the image.
    expect(server.calls[2]).toMatchObject({
      baseRevision: H1,
      content: { markdown: linked("v2") },
    });
    expect(server.calls[2]).not.toHaveProperty("assets");
    expect(server.calls[2]?.idempotencyKey).not.toBe(server.calls[0]?.idempotencyKey);
    expect(second.outcome).toMatchObject({ kind: "applied", commitSha: H2 });
    expect(second.retired.map((i) => i.uploadId)).toEqual([image.uploadId]);
    expect(second.images).toEqual([]);
    expect(second.memory).toEqual(initialEditorMemory());
    // Later saves never send the consumed upload or meet a headless conflict.
    const third = await runSave(server.deps, second, draft(linked("v3")));
    expect(third.outcome).toMatchObject({ kind: "applied" });
    expect(server.calls.at(-1)).not.toHaveProperty("assets");
  });

  it("a retry after an unknown outcome resends the identical record once", async () => {
    const server = mainServer();
    server.loseReply();
    const first = await runSave(server.deps, start(), draft(linked("v1")));
    const retry = await runSave(server.deps, first, draft(linked("v1")));
    expect(server.calls).toHaveLength(2);
    expect(server.calls[1]).toEqual(server.calls[0]);
    expect(retry.outcome).toMatchObject({ kind: "applied", commitSha: H1 });
    expect(retry.savedRev).toBe(H1);
    expect(retry.images).toEqual([]);
  });

  it("a record still without a receipt keeps the changed draft waiting", async () => {
    let fail = true;
    const server = mainServer();
    const flaky: EditorDeps = {
      ...server.deps,
      update: async (input) => {
        if (fail) throw new TypeError("offline");
        return server.deps.update(input);
      },
    };
    const first = await runSave(flaky, start(), draft(linked("v1")));
    const second = await runSave(flaky, first, draft(linked("v2")));
    expect(second.outcome).toEqual({ kind: "retryable" });
    expect(second.memory).toEqual(first.memory);
    expect(second.images).toEqual(first.images);
    fail = false;
    const third = await runSave(flaky, second, draft(linked("v2")));
    expect(server.calls.map((c) => (c.content as { markdown: string }).markdown)).toEqual([
      linked("v1"),
      linked("v2"),
    ]);
    expect(third.outcome).toMatchObject({ kind: "applied", commitSha: H2 });
  });

  it("a recovered create receipt sends the edited draft as an update", async () => {
    const server = mainServer();
    server.loseReply();
    const operations: string[] = [];
    const deps: EditorDeps = {
      ...server.deps,
      create: async (input) => {
        operations.push("create");
        return server.deps.update(input);
      },
      update: async (input) => {
        operations.push("update");
        return server.deps.update(input);
      },
    };
    // The caller only asks to write: create or update is the session's.
    const first = await runSave(
      deps,
      { ...start(), document: { exists: false, head: H0, path: "notes/a.md" } },
      draft(linked("v1")),
    );
    const second = await runSave(deps, first, draft(linked("v2")));
    expect(operations).toEqual(["create", "create", "update"]);
    expect(server.calls[1]).toEqual(server.calls[0]);
    expect(server.calls[2]).not.toHaveProperty("assets");
    expect(second.outcome).toMatchObject({ kind: "applied", commitSha: H2 });
  });

  it("retains a recovered creation when the follow-up conflicts, including after head adoption", async () => {
    const operations: string[] = [];
    let created = false;
    let conflict = true;
    const { deps: defaults } = recorder();
    const deps: EditorDeps = {
      ...defaults,
      create: async () => {
        operations.push("create");
        if (!created) {
          created = true;
          throw new TypeError("lost reply");
        }
        return applied({ commitSha: H1 });
      },
      update: async () => {
        operations.push("update");
        if (conflict)
          throw orpcError("CONFLICT", {
            details: browserConflictDetails({ headSha: H2, proposalNumber: null }),
          });
        return applied({ commitSha: H3 });
      },
    };
    const first = await runSave(
      deps,
      {
        ...start(),
        images: [],
        document: { exists: false, head: H0, path: "notes/a.md" },
      },
      draft("v1"),
    );
    const second = await runSave(deps, first, draft("v2"));
    expect(second.outcome.kind).toBe("conflict");
    expect(second.document).toEqual({ exists: true, head: H1, path: "notes/a.md" });
    conflict = false;
    const third = await runSave(deps, second, {
      ...draft("v2"),
      rebase: { headSha: H2, proposalNumber: null },
    });
    expect(third.outcome.kind).toBe("applied");
    expect(operations).toEqual(["create", "create", "update", "update"]);
  });

  it("recreates a PR document after accepting main's deletion, then updates it", async () => {
    const operations: string[] = [];
    const receipt = (head: string) =>
      applied({
        kind: "proposed",
        commitSha: head,
        indexJobId: null,
        proposal: {
          number: 7,
          title: "PR",
          sourceBranch: "pr/7",
          targetBranch: "main",
          baseSha: H0,
          headSha: head,
          targetSha: H0,
          status: "OPEN",
          authorActorKey: "user:x",
          version: 2,
          mergeCommitSha: null,
        },
      });
    const { deps: defaults } = recorder();
    const deps: EditorDeps = {
      ...defaults,
      remove: async () => {
        operations.push("delete");
        return receipt(H1);
      },
      create: async () => {
        operations.push("create");
        return receipt(H2);
      },
      update: async () => {
        operations.push("update");
        return receipt(H3);
      },
    };
    const deleted = await runSave(
      deps,
      {
        ...start(),
        images: [],
        proposal: { number: 7, headSha: H0 },
      },
      { kbId: KB, intent: { kind: "delete" } },
    );
    expect(deleted.document).toEqual({ exists: false, head: H1, path: "notes/a.md" });
    const recreated = await runSave(deps, deleted, draft("restored"));
    expect(recreated.document).toEqual({ exists: true, head: H2, path: "notes/a.md" });
    await runSave(deps, recreated, draft("edited"));
    expect(operations).toEqual(["delete", "create", "update"]);
  });

  it("a recovered create fixes the session's path: the next record updates it, never a stray copy", async () => {
    const operations: string[] = [];
    let lost = false;
    const { deps: defaults } = recorder();
    const deps: EditorDeps = {
      ...defaults,
      create: async (input) => {
        operations.push(`create:${input.path}`);
        if (!lost) {
          lost = true;
          throw new TypeError("lost reply");
        }
        return applied({ commitSha: H1 });
      },
      update: async (input) => {
        operations.push(`update:${input.path}`);
        return applied({ commitSha: H2 });
      },
    };
    const first = await runSave(
      deps,
      { ...start(), images: [], document: { exists: false, head: H0, path: "notes/a.md" } },
      draft("v1"),
    );
    expect(first.memory.request?.op).toMatchObject({ kind: "create", path: "notes/a.md" });
    // Even a state renamed while that record is unresolved (the hook refuses
    // it) cannot fork the document: the recovered receipt sets the path.
    const second = await runSave(
      deps,
      { ...first, document: { ...first.document, path: "notes/b.md" } },
      draft("v2"),
    );
    expect(second.receipt).toMatchObject({ kind: "applied", commitSha: H2 });
    expect(second.document).toEqual({ exists: true, head: H2, path: "notes/a.md" });
    expect(operations).toEqual(["create:notes/a.md", "create:notes/a.md", "update:notes/a.md"]);
  });

  it("a definite refusal of a create leaves no receipt and keeps the draft a create", async () => {
    const { deps } = recorder(() => orpcError("BAD_REQUEST"));
    const run = await runSave(
      deps,
      { ...start(), images: [], document: { exists: false, head: H0, path: "notes/a.md" } },
      draft("v1"),
    );
    expect(run.receipt).toBeNull();
    expect(run.memory).toEqual(initialEditorMemory());
    expect(run.document).toEqual({ exists: false, head: H0, path: "notes/a.md" });
  });

  it("a headless reservation keeps its immutable image request", async () => {
    const { deps } = recorder(() => orpcError("CONFLICT"));
    const first = await runSave(deps, start(), draft(linked("v1")));
    expect(first.memory.request?.op).toMatchObject({ markdown: linked("v1") });
    const second = await runSave(deps, first, draft(linked("v2")));
    expect(second.memory).toEqual(first.memory);
    expect(second.images).toEqual(first.images);
  });

  it("a definite refusal returns the record's images to staged", async () => {
    const { deps } = recorder(() => orpcError("BAD_REQUEST"));
    const run = await runSave(deps, start(), draft(linked("v1")));
    expect(run.outcome).toEqual({ kind: "error", reason: "rejected" });
    expect(run.memory).toEqual(initialEditorMemory());
    expect(run.images).toEqual([image]);
    expect(run.retired).toEqual([]);
  });
});

describe("confirmableConflict", () => {
  const doc = { kind: "document" as const, path: "notes/a.md" };
  const listing = (path: string) => ({
    mainSha: HEAD,
    paths: [
      { path, kind: "document" as const, baseSha: HEAD, theirsSha: HEAD, yoursSha: NEW_HEAD },
    ],
  });
  it("asks again at a moved head", () => {
    expect(
      confirmableConflict({ kind: "conflict", headSha: NEW_HEAD, proposalNumber: null }, doc),
    ).toEqual({ headSha: NEW_HEAD, proposalNumber: null });
  });
  it("asks again at the proposal head when the PR changed the written path", () => {
    expect(
      confirmableConflict(
        {
          kind: "conflict",
          headSha: NEW_HEAD,
          proposalNumber: 3,
          proposalConflict: listing("notes/a.md"),
        },
        doc,
      ),
    ).toEqual({ headSha: NEW_HEAD, proposalNumber: 3 });
  });
  it("cannot confirm a write blocked by other paths, or an unknown head", () => {
    expect(
      confirmableConflict(
        {
          kind: "conflict",
          headSha: NEW_HEAD,
          proposalNumber: 3,
          proposalConflict: listing("notes/b.md"),
        },
        doc,
      ),
    ).toBeNull();
    expect(
      confirmableConflict(
        {
          kind: "conflict",
          headSha: NEW_HEAD,
          proposalNumber: 3,
          proposalConflict: listing("notes/a.md"),
        },
        { kind: "asset", path: "notes/a.md" },
      ),
    ).toBeNull();
    expect(
      confirmableConflict({ kind: "conflict", headSha: null, proposalNumber: null }, doc),
    ).toBeNull();
  });
});
