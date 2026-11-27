import { configureLockSlots } from "@knowledge-base/db/lock-slots";
import { captureLog, validateLogRecord } from "@knowledge-base/env/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  locks: new Set<string>(),
  verification: { findFirst: vi.fn() },
  sessionFindFirst: vi.fn(),
  $transaction: vi.fn(),
}));

const quarantine = vi.hoisted(() => vi.fn(async (_userId: string) => {}));

vi.mock("@knowledge-base/db", () => ({ default: db }));
vi.mock("./credential-revocation.js", () => ({ quarantineUntrustedPasswordWrite: quarantine }));
// Pool of 3 → two lock slots: exactly one password write (its lock plus the
// revocation it runs) at a time.
configureLockSlots(3);

const { withLockSlot: withCliCredentialLockSlot } = await import("./lock-slots");
const { releaseSlots, tryAcquireSlots } = await import("./lock-slots");
const { passwordWriteLockHeld, passwordWriteLockKey, withPasswordWriteLock } = await import(
  "./password-write-lock"
);

const ok = () => new Response("ok");
const noSession = async () => null;
const post = (path: string, body: unknown, query = "") =>
  new Request(`https://app.example.test/api/auth${path}${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

let log: ReturnType<typeof captureLog>;
beforeEach(() => {
  log = captureLog();
  vi.clearAllMocks();
  db.locks.clear();
  db.$transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
    const held: string[] = [];
    try {
      return await work({
        $queryRaw: async (_strings: TemplateStringsArray, key: string) => {
          if (held.includes(key)) return [{ locked: true }]; // re-entrant
          if (db.locks.has(key)) return [{ locked: false }];
          db.locks.add(key);
          held.push(key);
          return [{ locked: true }];
        },
        session: { findFirst: db.sessionFindFirst },
      });
    } finally {
      for (const key of held) db.locks.delete(key);
    }
  });
});
afterEach(() => {
  log.restore();
  vi.restoreAllMocks();
});

describe("guardPasswordAccountCreate", () => {
  it.each([
    undefined,
    null,
    {},
    { path: "/set-password" },
    { path: "/anything" },
    { path: "/admin/create-user" },
  ])("refuses an unlocked password-bearing create with context %j", async (context) => {
    const { guardPasswordAccountCreate } = await import("./password-write-lock");
    expect(() => guardPasswordAccountCreate({ password: "hash" }, context)).toThrow(
      /password-write lock/,
    );
  });

  it("allows only sign-up and the server-granted admin invite to create first credentials unlocked", async () => {
    const { guardPasswordAccountCreate } = await import("./password-write-lock");
    const { runWithAllowedUserCreation } = await import("./user-creation-policy");
    expect(() =>
      guardPasswordAccountCreate({ password: "hash" }, { path: "/sign-up/email" }),
    ).not.toThrow();
    await runWithAllowedUserCreation("admin-invite", async () => {
      expect(() =>
        guardPasswordAccountCreate({ password: "hash" }, { path: "/admin/create-user" }),
      ).not.toThrow();
      // The invite grant alone cannot exempt a server-only password write.
      expect(() => guardPasswordAccountCreate({ password: "hash" }, undefined)).toThrow(
        /password-write lock/,
      );
    });
    await runWithAllowedUserCreation("admin-bootstrap", async () => {
      expect(() =>
        guardPasswordAccountCreate({ password: "hash" }, { path: "/admin/create-user" }),
      ).toThrow(/password-write lock/);
    });
  });

  it.each([undefined, null, {}, { path: "/callback/sso" }, { path: "/sign-in/social" }])(
    "allows a passwordless IdP account with context %j",
    async (context) => {
      const { guardPasswordAccountCreate } = await import("./password-write-lock");
      for (const account of [{}, { password: null }, { password: undefined }]) {
        expect(() => guardPasswordAccountCreate(account, context)).not.toThrow();
      }
    },
  );

  it("confirms a locked password-bearing create without endpoint context", async () => {
    const { guardPasswordAccountCreate, confirmPasswordWriteLocked } = await import(
      "./password-write-lock"
    );
    const response = await withPasswordWriteLock(
      "/admin/set-user-password",
      post("/admin/set-user-password", { userId: "u1" }),
      async () => {
        guardPasswordAccountCreate({ password: "hash" }, undefined);
        await confirmPasswordWriteLocked();
        return ok();
      },
      { getSession: noSession },
    );
    expect(response.status).toBe(200);
    expect(quarantine).not.toHaveBeenCalled();
  });
});

describe("withPasswordWriteLock", () => {
  it("locks the user a reset token belongs to (body or query), and the user an admin sets", async () => {
    db.verification.findFirst.mockResolvedValue({ value: "u1" });
    const seen: string[] = [];
    const run = async () => {
      seen.push(`${[...db.locks].join(",")}:${passwordWriteLockHeld()}`);
      return ok();
    };
    await withPasswordWriteLock("/reset-password", post("/reset-password", { token: "tk" }), run, {
      getSession: noSession,
    });
    await withPasswordWriteLock("/reset-password", post("/reset-password", {}, "?token=tq"), run, {
      getSession: noSession,
    });
    await withPasswordWriteLock(
      "/admin/set-user-password",
      post("/admin/set-user-password", { userId: "u2", newPassword: "x" }),
      run,
      { getSession: noSession },
    );
    expect(db.verification.findFirst.mock.calls.map(([q]) => q.where.identifier)).toEqual([
      "reset-password:tk",
      "reset-password:tq",
    ]);
    expect(seen).toEqual([
      `${passwordWriteLockKey("u1")}:true`,
      `${passwordWriteLockKey("u1")}:true`,
      `${passwordWriteLockKey("u2")}:true`,
    ]);
    expect(passwordWriteLockHeld()).toBe(false);
  });

  it("runs unlocked when there is no target (unknown token, no session)", async () => {
    db.verification.findFirst.mockResolvedValue(null);
    const run = vi.fn(async () => {
      expect(passwordWriteLockHeld()).toBe(false);
      return ok();
    });
    await withPasswordWriteLock("/reset-password", post("/reset-password", { token: "x" }), run, {
      getSession: noSession,
    });
    await withPasswordWriteLock("/change-password", post("/change-password", {}), run, {
      getSession: noSession,
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("re-checks a change's session inside the lock and answers 401 without running when it is gone", async () => {
    db.sessionFindFirst.mockResolvedValue(null);
    const run = vi.fn(async () => ok());
    const res = await withPasswordWriteLock("/change-password", post("/change-password", {}), run, {
      getSession: async () => ({ user: { id: "u1" }, session: { id: "s1" } }),
    });
    expect(res.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
    expect(db.sessionFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "s1",
          userId: "u1",
          expiresAt: { gt: expect.any(Date) },
        }),
      }),
    );
  });

  it("two concurrent password writes that each run a revocation both finish (slots reserved up front)", async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const write = (userId: string) =>
      withPasswordWriteLock(
        "/admin/set-user-password",
        post("/admin/set-user-password", { userId }),
        async () => {
          await gate;
          // The credential revocation the reset/change handler runs.
          await withCliCredentialLockSlot(async () => undefined);
          return ok();
        },
        { getSession: noSession },
      );
    const both = Promise.all([write("u1"), write("u2")]);
    open();
    const results = await Promise.race([
      both,
      new Promise<"deadlock">((resolve) => setTimeout(() => resolve("deadlock"), 2_000)),
    ]);
    expect(results).not.toBe("deadlock");
  });

  it("answers 503 when every lock slot stays taken past the wait, and leaves no waiter behind", async () => {
    expect(tryAcquireSlots(2)).toBe(true);
    const run = vi.fn(async () => ok());
    const res = await withPasswordWriteLock(
      "/admin/set-user-password",
      post("/admin/set-user-password", { userId: "u1" }),
      run,
      { getSession: noSession, waitMs: 60 },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "PASSWORD_WRITE_BUSY" });
    expect(run).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
    releaseSlots(2);
    // The expired waiter left the queue: the slots are free again.
    expect(tryAcquireSlots(2)).toBe(true);
    releaseSlots(2);
  });

  it("one deadline covers the slot wait and the lock wait", async () => {
    expect(tryAcquireSlots(2)).toBe(true);
    db.locks.add(passwordWriteLockKey("u1"));
    setTimeout(() => releaseSlots(2), 150);
    const started = performance.now();
    const res = await withPasswordWriteLock(
      "/admin/set-user-password",
      post("/admin/set-user-password", { userId: "u1" }),
      async () => ok(),
      { getSession: noSession, waitMs: 250 },
    );
    const took = performance.now() - started;
    expect(res.status).toBe(503);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    // 250 ms in total, not 150 ms of slot wait plus a fresh 250 ms of polling.
    expect(took).toBeLessThan(380);
    expect(took).toBeGreaterThanOrEqual(240);
  });

  it("confirms a password write only while the lock transaction is open and the flag holds", async () => {
    const { confirmPasswordWriteLocked, guardPasswordAccountUpdate } = await import(
      "./password-write-lock"
    );
    // Outside any lock: nothing to confirm, and the guard refuses the write.
    await expect(confirmPasswordWriteLocked()).resolves.toBeUndefined();
    expect(() => guardPasswordAccountUpdate({ password: "h" })).toThrow(/password-write lock/);
    // A non-password update is not a password write.
    expect(() => guardPasswordAccountUpdate({ accessToken: "t" })).not.toThrow();
    const res = await withPasswordWriteLock(
      "/admin/set-user-password",
      post("/admin/set-user-password", { userId: "u1" }),
      async () => {
        guardPasswordAccountUpdate({ password: "h" });
        await confirmPasswordWriteLocked();
        return ok();
      },
      { getSession: noSession },
    );
    expect(res.status).toBe(200);
  });

  describe("a lock transaction whose commit rejects", () => {
    /** Runs the callback like the real client, then rejects at commit once `closed`. */
    const expiringTransaction = () => {
      const state = { closed: false };
      db.$transaction.mockImplementationOnce(async (work: (tx: unknown) => Promise<unknown>) => {
        const result = await work({
          $queryRaw: async () => {
            if (state.closed) throw new Error("Transaction already closed");
            return [{ locked: true }];
          },
          session: { findFirst: db.sessionFindFirst },
        });
        if (state.closed) throw new Error("Transaction already closed");
        return result;
      });
      return state;
    };
    const target = () => post("/admin/set-user-password", { userId: "u1" });

    it("keeps the quarantine's 409 answer when the expired transaction then fails", async () => {
      const rawLog = vi.spyOn(console, "error").mockImplementation(() => {});
      const { confirmPasswordWriteLocked, guardPasswordAccountUpdate } = await import(
        "./password-write-lock"
      );
      const state = expiringTransaction();
      const res = await withPasswordWriteLock(
        "/admin/set-user-password",
        target(),
        async () => {
          guardPasswordAccountUpdate({ password: "h" });
          state.closed = true;
          // Better-Auth turns the hook's APIError into the response.
          const error = await confirmPasswordWriteLocked().catch((e: unknown) => e);
          return new Response(
            JSON.stringify({ code: (error as { body?: { code?: string } }).body?.code }),
            {
              status: 409,
            },
          );
        },
        { getSession: noSession },
      );
      expect(quarantine.mock.calls[0]?.[0]).toBe("u1");
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ code: "PASSWORD_WRITE_UNCONFIRMED" });
      expect(log.records).toEqual([
        {
          level: "error",
          site: "auth.password-write-unconfirmed",
          message:
            "password write outlived its lock; quarantining the credential and revoking sessions",
        },
      ]);
      expect(validateLogRecord(log.records[0])).toEqual(log.records[0]);
      expect(JSON.stringify(log.records)).not.toContain("u1");
      expect(rawLog).not.toHaveBeenCalled();
      rawLog.mockRestore();
    });

    it("does not mask a commit failure when nothing was quarantined", async () => {
      const state = expiringTransaction();
      await expect(
        withPasswordWriteLock(
          "/admin/set-user-password",
          target(),
          async () => {
            state.closed = true;
            return ok();
          },
          { getSession: noSession },
        ),
      ).rejects.toThrow("Transaction already closed");
      expect(quarantine).not.toHaveBeenCalled();
    });

    it("does not mask a commit failure when the quarantine itself failed", async () => {
      const { confirmPasswordWriteLocked, guardPasswordAccountUpdate } = await import(
        "./password-write-lock"
      );
      quarantine.mockRejectedValueOnce(new Error("quarantine failed"));
      const state = expiringTransaction();
      await expect(
        withPasswordWriteLock(
          "/admin/set-user-password",
          target(),
          async () => {
            guardPasswordAccountUpdate({ password: "h" });
            state.closed = true;
            await confirmPasswordWriteLocked().catch(() => {});
            return new Response("error", { status: 500 });
          },
          { getSession: noSession },
        ),
      ).rejects.toThrow("Transaction already closed");
    });
  });
});
