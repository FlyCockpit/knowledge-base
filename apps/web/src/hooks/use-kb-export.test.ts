import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelFailedFor,
  downloadPreparedExport,
  EXPORT_POLL_MS,
  type ExportJob,
  type ExportPrepared,
  exportDenied,
  exportPercent,
  exportView,
  isActiveJob,
  kbExportDownloadUrl,
  statusPollInterval,
  visibleJob,
} from "@/hooks/use-kb-export";
import {
  isDocumentReplaced,
  observeDocumentIdentity,
  resetDocumentIdentityForTests,
} from "@/lib/document-identity";

const KB = "d".repeat(24);
const TRANSFER = "0b4f7c3e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
const BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]);
const hashOf = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const NOW = Date.parse("2026-09-26T12:00:00Z");

afterEach(() => {
  vi.unstubAllGlobals();
  resetDocumentIdentityForTests();
});

function prepared(overrides: Partial<ExportPrepared> = {}): ExportPrepared {
  return {
    transferId: TRANSFER,
    size: BYTES.length,
    contentHash: hashOf(BYTES),
    expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
    ...overrides,
  };
}

function run(
  fetchImpl: typeof fetch,
  input: Partial<Parameters<typeof downloadPreparedExport>[0]> = {},
) {
  const save = vi.fn();
  const acknowledge = vi.fn(async () => undefined);
  const outcome = downloadPreparedExport({
    kbId: KB,
    kind: "whole",
    prepared: prepared(),
    fetchImpl,
    now: () => NOW,
    save,
    acknowledge,
    ...input,
  });
  return { outcome, save, acknowledge };
}

describe("kbExportDownloadUrl", () => {
  it("is the exact same-origin artifact route without any token or query", () => {
    expect(kbExportDownloadUrl(KB, TRANSFER)).toBe(`/kb-exports/${KB}/${TRANSFER}`);
  });
  it("refuses malformed identifiers", () => {
    expect(() => kbExportDownloadUrl("../../x", TRANSFER)).toThrow();
    expect(() => kbExportDownloadUrl(KB, "not-a-uuid")).toThrow();
  });
});

describe("downloadPreparedExport", () => {
  it("sends the document owner and replaces a switched document before reporting an outcome", async () => {
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { reload } });
    resetDocumentIdentityForTests(() => undefined);
    observeDocumentIdentity("a");
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ code: "IDENTITY_CHANGED" }, { status: 409 }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const save = vi.fn();
    const acknowledge = vi.fn();
    let settled = false;
    void downloadPreparedExport({
      kbId: KB,
      kind: "whole",
      prepared: prepared(),
      now: () => NOW,
      save,
      acknowledge,
    }).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("X-Expected-User")).toBe("a");
    expect(isDocumentReplaced()).toBe(true);
    expect(settled).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });

  it("saves exactly the artifact bytes fetched from the authorized route", async () => {
    const fetchImpl = vi.fn(async () => new Response(BYTES, { status: 200 }));
    const { outcome, save } = run(fetchImpl as unknown as typeof fetch);
    expect(await outcome).toEqual({ status: "done", kind: "whole", size: BYTES.length });
    expect(fetchImpl).toHaveBeenCalledWith(`/kb-exports/${KB}/${TRANSFER}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(save).toHaveBeenCalledTimes(1);
    const [blob, name] = save.mock.calls[0]!;
    expect(new Uint8Array(await (blob as Blob).arrayBuffer())).toEqual(BYTES);
    expect(name).toBe(`knowledge-base-${KB}-whole.zip`);
  });

  it("an already expired transfer fails visibly without fetching", async () => {
    const fetchImpl = vi.fn();
    const { outcome, save } = run(fetchImpl as unknown as typeof fetch, {
      prepared: prepared({ expiresAt: new Date(NOW - 1).toISOString() }),
    });
    expect(await outcome).toEqual({ status: "expired", kind: "whole" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it.each([404, 401, 403])(
    "a revoked or expired transfer (%i) is reported expired",
    async (status) => {
      const { outcome, save } = run(
        (async () => new Response('{"error":"NOT_FOUND"}', { status })) as unknown as typeof fetch,
      );
      expect(await outcome).toEqual({ status: "expired", kind: "whole" });
      expect(save).not.toHaveBeenCalled();
    },
  );

  it.each([500, 503])("a server failure (%i) is an error", async (status) => {
    const { outcome, save } = run(
      (async () => new Response("x", { status })) as unknown as typeof fetch,
    );
    expect(await outcome).toEqual({ status: "error", kind: "whole" });
    expect(save).not.toHaveBeenCalled();
  });

  it("a network failure is an error", async () => {
    const { outcome } = run((async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch);
    expect(await outcome).toEqual({ status: "error", kind: "whole" });
  });

  it("bytes that do not match the prepared hash or size are never saved", async () => {
    const tampered = new Uint8Array(BYTES);
    tampered[5] = 99;
    const { outcome, save } = run(
      (async () => new Response(tampered, { status: 200 })) as unknown as typeof fetch,
    );
    expect(await outcome).toEqual({ status: "error", kind: "whole" });
    expect(save).not.toHaveBeenCalled();
    const short = run(
      (async () => new Response(BYTES.slice(0, 4), { status: 200 })) as unknown as typeof fetch,
    );
    expect(await short.outcome).toEqual({ status: "error", kind: "whole" });
  });

  it("acknowledges completion only after the verified bytes were saved", async () => {
    const order: string[] = [];
    const save = vi.fn(() => {
      order.push("save");
    });
    const acknowledge = vi.fn(async () => {
      order.push("ack");
    });
    const { outcome } = run(
      (async () => new Response(BYTES, { status: 200 })) as unknown as typeof fetch,
      { save, acknowledge },
    );
    expect(await outcome).toEqual({ status: "done", kind: "whole", size: BYTES.length });
    expect(acknowledge).toHaveBeenCalledWith({ kbId: KB, transferId: TRANSFER });
    expect(order).toEqual(["save", "ack"]);
  });

  it("a failed acknowledgement keeps the saved download done (grace releases it)", async () => {
    const { outcome, save } = run(
      (async () => new Response(BYTES, { status: 200 })) as unknown as typeof fetch,
      { acknowledge: vi.fn(async () => Promise.reject(new Error("offline"))) },
    );
    expect(await outcome).toEqual({ status: "done", kind: "whole", size: BYTES.length });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("publishes saved success even when acknowledgement never settles", async () => {
    const acknowledge = vi.fn(() => new Promise<never>(() => {}));
    const { outcome, save } = run((async () => new Response(BYTES)) as typeof fetch, {
      acknowledge,
    });
    expect(await outcome).toEqual({ status: "done", kind: "whole", size: BYTES.length });
    expect(save).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it("a synchronously thrown acknowledgement cannot undo saved success", async () => {
    const { outcome, save } = run((async () => new Response(BYTES)) as typeof fetch, {
      acknowledge: () => {
        throw new Error("offline");
      },
    });
    expect(await outcome).toEqual({ status: "done", kind: "whole", size: BYTES.length });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("never acknowledges a download that was not saved", async () => {
    const tampered = new Uint8Array(BYTES);
    tampered[5] = 99;
    for (const response of [
      new Response(tampered, { status: 200 }),
      new Response("x", { status: 503 }),
      new Response("x", { status: 404 }),
    ]) {
      const { outcome, acknowledge } = run((async () => response) as unknown as typeof fetch);
      await outcome;
      expect(acknowledge).not.toHaveBeenCalled();
    }
  });
});

const job = (overrides: Partial<ExportJob> = {}): ExportJob => ({
  transferId: TRANSFER,
  kind: "assets",
  rev: "7".repeat(40),
  state: "building",
  progress: { doneBytes: 0, totalBytes: null },
  size: null,
  contentHash: null,
  expiresAt: null,
  error: null,
  ...overrides,
});
const base = {
  startedHere: true,
  download: null,
  lookupPending: false,
  lookupFailed: false,
} as const;

describe("export job view", () => {
  it("only pending and building jobs are active (polled)", () => {
    expect(isActiveJob(job({ state: "pending" }))).toBe(true);
    expect(isActiveJob(job({ state: "building" }))).toBe(true);
    for (const state of ["ready", "failed", "cancelled", "expired"] as const)
      expect(isActiveJob(job({ state }))).toBe(false);
    expect(isActiveJob(null)).toBe(false);
  });

  it("keeps polling a building job while no status read has succeeded yet", () => {
    // A failed first status read leaves `data` undefined: the started job decides.
    expect(statusPollInterval(undefined, job({ state: "building" }))).toBe(EXPORT_POLL_MS);
    expect(statusPollInterval(undefined, null)).toBe(false);
    // Once a read succeeds, its state wins over the stale started job.
    expect(statusPollInterval(job({ state: "ready" }), job({ state: "building" }))).toBe(false);
    expect(statusPollInterval(job({ state: "pending" }), null)).toBe(EXPORT_POLL_MS);
  });

  it("a denied status read stops polling and hides the cached job", () => {
    const denied = Object.assign(new Error("Export not found"), { code: "NOT_FOUND" });
    const forbidden = Object.assign(new Error("Forbidden"), { code: "FORBIDDEN" });
    const transient = Object.assign(new Error("Unavailable"), { code: "STORAGE_UNAVAILABLE" });
    expect(statusPollInterval(job({ state: "building" }), null, denied)).toBe(false);
    expect(statusPollInterval(job({ state: "building" }), null, forbidden)).toBe(false);
    // A transient failure keeps polling (recovery), never hides the job.
    expect(statusPollInterval(job({ state: "building" }), null, transient)).toBe(EXPORT_POLL_MS);
    expect(exportDenied(false, [null, transient])).toBe(false);
    expect(exportDenied(false, [denied])).toBe(true);
    expect(exportDenied(true, [])).toBe(true);
  });

  it("shows the freshest read of the tracked job and nothing once denied", () => {
    const tracked = job({ state: "building" });
    const fresh = job({ state: "ready" });
    const base = { denied: false, trackedId: tracked.transferId, own: tracked, latest: null };
    expect(visibleJob({ ...base, status: fresh })).toBe(fresh);
    expect(visibleJob({ ...base, status: undefined })).toBe(tracked);
    expect(visibleJob({ ...base, denied: true, status: fresh })).toBeNull();
    expect(visibleJob({ ...base, trackedId: null, status: undefined })).toBeNull();
  });

  it("a failed cancel of job A is not shown once job B is on screen", () => {
    const a = job({ state: "building" });
    const b = job({ state: "building", transferId: "1c5e8d4f-2a3b-4c5d-9e6f-7a8b9c0d1e2f" });
    expect(cancelFailedFor(a, { failed: true, transferId: a.transferId })).toBe(true);
    // A failed, the user retried: B is displayed while the cancel error is A's.
    expect(cancelFailedFor(b, { failed: true, transferId: a.transferId })).toBe(false);
    expect(cancelFailedFor(null, { failed: true, transferId: a.transferId })).toBe(false);
    expect(cancelFailedFor(a, { failed: false, transferId: a.transferId })).toBe(false);
  });

  it("percent is known only with a total, bounded and whole", () => {
    expect(exportPercent(job())).toBeNull();
    expect(exportPercent(job({ progress: { doneBytes: 1, totalBytes: 3 } }))).toBe(33);
    expect(exportPercent(job({ progress: { doneBytes: 9, totalBytes: 3 } }))).toBe(100);
    expect(exportPercent(job({ progress: { doneBytes: 0, totalBytes: 0 } }))).toBe(0);
    expect(exportPercent(job({ state: "ready", progress: { doneBytes: 0, totalBytes: 0 } }))).toBe(
      100,
    );
  });

  it("maps a job to the panel state", () => {
    expect(exportView({ ...base, job: null, lookupPending: true })).toEqual({ status: "loading" });
    expect(exportView({ ...base, job: null, lookupFailed: true })).toEqual({
      status: "idle",
      lookupFailed: true,
    });
    expect(
      exportView({ ...base, job: job({ progress: { doneBytes: 5, totalBytes: 10 } }) }),
    ).toMatchObject({ status: "preparing", percent: 50 });
    expect(exportView({ ...base, job: job({ state: "ready" }) })).toMatchObject({
      status: "ready",
      download: null,
    });
    expect(exportView({ ...base, job: job({ state: "failed" }) }).status).toBe("failed");
    expect(exportView({ ...base, job: job({ state: "cancelled" }) }).status).toBe("cancelled");
    expect(exportView({ ...base, job: job({ state: "expired" }) }).status).toBe("expired");
  });

  it("a failure from an earlier visit is shown; old cancelled or expired jobs are not", () => {
    const earlier = { ...base, startedHere: false };
    expect(exportView({ ...earlier, job: job({ state: "failed" }) }).status).toBe("failed");
    expect(exportView({ ...earlier, job: job({ state: "cancelled" }) }).status).toBe("idle");
    expect(exportView({ ...earlier, job: job({ state: "expired" }) }).status).toBe("idle");
    expect(exportView({ ...earlier, job: job() }).status).toBe("preparing");
  });

  it("an acknowledged (released) download still reads as done", () => {
    expect(
      exportView({
        ...base,
        job: job({ state: "expired" }),
        download: { status: "done", size: 3 },
      }),
    ).toMatchObject({ status: "ready", download: { status: "done", size: 3 } });
  });
});
