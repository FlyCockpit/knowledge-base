import { runWithTransaction } from "@better-auth/core/context";
import { captureLog } from "@knowledge-base/env/log";
import { describe, expect, it, vi } from "vitest";
import {
  drainVerificationMail,
  MAX_DETACHED_VERIFICATION_MAILS,
  sendVerificationMailAfterCommit,
  VERIFICATION_MAIL_LOG_SITE,
  VERIFICATION_MAIL_SKIPPED_LOG_SITE,
} from "./verification-mail";

type FakeAdapter = Parameters<typeof runWithTransaction>[0];

function fakeAdapter(events: string[]): FakeAdapter {
  const adapter = {
    options: { adapterConfig: { transaction: true } },
    transaction: async <R>(fn: (trx: unknown) => Promise<R>) => {
      events.push("begin");
      try {
        const result = await fn(adapter);
        events.push("commit");
        return result;
      } catch (error) {
        events.push("rollback");
        throw error;
      }
    },
  };
  return adapter as unknown as FakeAdapter;
}

describe("sendVerificationMailAfterCommit", () => {
  it("awaits the send and surfaces its failure outside a transaction", async () => {
    const send = vi.fn(async () => {
      throw new Error("smtp down");
    });
    await expect(sendVerificationMailAfterCommit(send)).rejects.toThrow("smtp down");
    expect(send).toHaveBeenCalledOnce();
  });

  it("sends only after the commit and does not hold the transaction for it", async () => {
    const events: string[] = [];
    let finish: () => void = () => {};
    const send = vi.fn(() => {
      events.push("send");
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await runWithTransaction(fakeAdapter(events), async () => {
      await sendVerificationMailAfterCommit(send);
      events.push("insert done");
    });
    // The transaction returned although the send has not settled.
    expect(events).toEqual(["begin", "insert done", "commit", "send"]);
    finish();
  });

  it("sends nothing when the transaction rolls back", async () => {
    const events: string[] = [];
    const send = vi.fn(async () => {});
    await expect(
      runWithTransaction(fakeAdapter(events), async () => {
        await sendVerificationMailAfterCommit(send);
        throw new Error("unique violation");
      }),
    ).rejects.toThrow("unique violation");
    expect(events).toEqual(["begin", "rollback"]);
    expect(send).not.toHaveBeenCalled();
  });

  it("logs a failed detached send by class only", async () => {
    const log = captureLog();
    try {
      await runWithTransaction(fakeAdapter([]), async () => {
        await sendVerificationMailAfterCommit(async () => {
          throw new Error("535 auth failed for secret-user");
        });
      });
      await vi.waitFor(() =>
        expect(log.records.some((r) => r.site === VERIFICATION_MAIL_LOG_SITE)).toBe(true),
      );
      expect(JSON.stringify(log.records)).not.toContain("secret-user");
    } finally {
      log.restore();
    }
  });

  it("bounds the detached sends in flight and logs the ones it skips", async () => {
    const releases: Array<() => void> = [];
    const hanging = () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    const log = captureLog();
    try {
      for (let i = 0; i < MAX_DETACHED_VERIFICATION_MAILS; i++) {
        await runWithTransaction(fakeAdapter([]), () => sendVerificationMailAfterCommit(hanging));
      }
      const extra = vi.fn(async () => {});
      await runWithTransaction(fakeAdapter([]), () => sendVerificationMailAfterCommit(extra));
      expect(extra).not.toHaveBeenCalled();
      expect(log.records).toContainEqual(
        expect.objectContaining({ site: VERIFICATION_MAIL_SKIPPED_LOG_SITE, level: "warn" }),
      );
      // Shutdown waits only up to its bound and reports what is still running.
      expect(await drainVerificationMail(20)).toBe(MAX_DETACHED_VERIFICATION_MAILS);
      const drained = drainVerificationMail(5_000);
      for (const release of releases) release();
      expect(await drained).toBe(0);
      // Capacity is back once they settle.
      const next = vi.fn(async () => {});
      await runWithTransaction(fakeAdapter([]), () => sendVerificationMailAfterCommit(next));
      expect(next).toHaveBeenCalledOnce();
    } finally {
      log.restore();
    }
  });
});
