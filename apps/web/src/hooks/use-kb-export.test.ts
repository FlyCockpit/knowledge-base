import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  downloadPreparedExport,
  type ExportPrepared,
  kbExportDownloadUrl,
} from "@/hooks/use-kb-export";

const KB = "d".repeat(24);
const TRANSFER = "0b4f7c3e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
const BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]);
const hashOf = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const NOW = Date.parse("2026-09-26T12:00:00Z");

function prepared(overrides: Partial<ExportPrepared> = {}): ExportPrepared {
  return {
    transferId: TRANSFER,
    rev: "7".repeat(40),
    size: BYTES.length,
    contentHash: hashOf(BYTES),
    expiresAt: new Date(NOW + 15 * 60_000).toISOString(),
    mime: "application/zip",
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
