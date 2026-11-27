import { configureLockSlots } from "@knowledge-base/db/lock-slots";
import { captureLog, validateLogRecord } from "@knowledge-base/env/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A real Better-Auth handler on its in-memory adapter, wired with the same
// fence hooks and reset revocation as index.ts. `@knowledge-base/db` is a small
// stand-in over the SAME tables, so the fence and the real revocation see
// exactly what Better-Auth wrote. Never a real database.
type Row = Record<string, unknown>;
const tables = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  /** Every `@knowledge-base/db` query, as `model.method`. */
  queries: [] as string[],
  /** Advisory locks held, by key (released when the holding transaction ends). */
  locks: new Set<string>(),
  /**
   * Time out every open interactive transaction, as Prisma does at its
   * timeout: its locks are released and its client rejects from then on,
   * while the callback keeps running.
   */
  expireTransactions: [] as (() => void)[],
}));

configureLockSlots(10);
vi.mock("@knowledge-base/db", () => {
  type Where = Record<string, unknown>;
  const matches = (row: Row, where: Where): boolean =>
    Object.entries(where).every(([field, condition]) => {
      if (field === "OR") return (condition as Where[]).some((clause) => matches(row, clause));
      // The one relation filter the code uses: an account's user by email.
      if (field === "user") {
        const user = (tables.db.user ?? []).find((u) => u.id === row.userId);
        return user !== undefined && matches(user, condition as Where);
      }
      const value = row[field];
      if (condition === null || typeof condition !== "object" || condition instanceof Date) {
        return value === condition;
      }
      const c = condition as { in?: unknown[]; startsWith?: string; not?: unknown; gt?: Date };
      if (c.in) return c.in.includes(value);
      if (c.gt) return value instanceof Date && value > c.gt;
      if (c.startsWith !== undefined) return String(value).startsWith(c.startsWith);
      if ("not" in c) return value !== c.not;
      throw new Error(`unsupported condition on ${field}`);
    });
  const logged =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      tables.queries.push(name);
      return fn(...args);
    };
  const table = (model: string) => ({
    findFirst: logged(
      `${model}.findFirst`,
      async ({ where }: { where: Where }) =>
        (tables.db[model] ?? []).find((row) => matches(row, where)) ?? null,
    ),
    findUnique: logged(
      `${model}.findUnique`,
      async ({ where }: { where: Where }) =>
        (tables.db[model] ?? []).find((row) => matches(row, where)) ?? null,
    ),
    create: async ({ data }: { data: Row }) => {
      const row = { id: `${model}-${Math.random().toString(36).slice(2)}`, ...data };
      tables.db[model] = [...(tables.db[model] ?? []), row];
      return row;
    },
    deleteMany: async ({ where }: { where: Where }) => {
      const before = tables.db[model] ?? [];
      tables.db[model] = before.filter((row) => !matches(row, where));
      return { count: before.length - (tables.db[model]?.length ?? 0) };
    },
    updateMany: async ({ where, data }: { where: Where; data: Row }) => {
      const hit = (tables.db[model] ?? []).filter((row) => matches(row, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    },
  });
  return {
    default: {
      user: table("user"),
      account: table("account"),
      session: table("session"),
      verification: table("verification"),
      apiKey: table("apikey"),
      deviceCode: table("deviceCode"),
      // A batch runs its statements; an interactive transaction gets a
      // client with the try-lock (password-write-lock.ts), released at its end.
      $transaction: async (
        work: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>),
      ): Promise<unknown> => {
        if (typeof work !== "function") return Promise.all(work);
        const held: string[] = [];
        let closed = false;
        const release = () => {
          for (const key of held) tables.locks.delete(key);
          held.length = 0;
        };
        const expire = () => {
          closed = true;
          release();
        };
        tables.expireTransactions.push(expire);
        const open =
          <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
          async (...args: A): Promise<R> => {
            if (closed) throw new Error("Transaction already closed");
            return fn(...args);
          };
        const session = table("session");
        try {
          const result = await work({
            $queryRaw: open(async (strings: TemplateStringsArray, ...values: unknown[]) => {
              if (!strings.join("?").includes("pg_try_advisory_xact_lock(hashtext(?))")) {
                throw new Error("unexpected SQL");
              }
              const key = String(values[0]);
              if (held.includes(key)) return [{ locked: true }]; // re-entrant
              if (tables.locks.has(key)) return [{ locked: false }];
              tables.locks.add(key);
              held.push(key);
              return [{ locked: true }];
            }),
            session: { ...session, findFirst: open(session.findFirst) },
            account: table("account"),
            deviceCode: table("deviceCode"),
            $executeRaw: async () => 0,
            $executeRawUnsafe: async (statement: string, userId: string) => {
              if (!statement.includes('FROM "verification" v')) return 0;
              // Model the revoker's effects on the SAME memory-adapter rows.
              // This does not execute or validate SQL; the real Postgres cleanup
              // regression in password-reset-links.integration.test.ts owns that proof.
              const rows = tables.db.verification ?? [];
              const ownedChallenges = new Set(
                rows
                  .filter(
                    (row) => row.value === userId && String(row.identifier).startsWith("2fa-"),
                  )
                  .map((row) => String(row.identifier)),
              );
              tables.db.verification = rows.filter((row) => {
                const identifier = String(row.identifier);
                if (
                  row.value === userId &&
                  (identifier.startsWith("2fa-") || identifier.startsWith("trust-device-"))
                )
                  return false;
                for (const prefix of ["2fa-attempts-", "2fa-otp-"]) {
                  if (
                    identifier.startsWith(prefix) &&
                    ownedChallenges.has(identifier.slice(prefix.length))
                  )
                    return false;
                }
                return !identifier.startsWith(`2fa-otp-${userId}!`);
              });
              return rows.length - tables.db.verification.length;
            },
          });
          // Like Prisma: an interactive transaction that expired before the
          // callback returned rejects at commit.
          if (closed)
            throw new Error(
              "Transaction already closed: the timeout for this transaction was exceeded",
            );
          return result;
        } finally {
          release();
          tables.expireTransactions.splice(tables.expireTransactions.indexOf(expire), 1);
        }
      },
    },
  };
});

const { betterAuth } = await import("better-auth");
const { memoryAdapter } = await import("better-auth/adapters/memory");
const { hashPassword, verifyPassword } = await import("better-auth/crypto");
const { twoFactor } = await import("better-auth/plugins");
const { createAuthMiddleware } = await import("better-auth/api");
const {
  passwordChangeRevocationTarget,
  revokeCredentialsAfterPasswordChange,
  revokeCredentialsAfterPasswordReset,
} = await import("./credential-revocation");
const fence = await import("./password-sign-in-fence");
const writeLock = await import("./password-write-lock");

const BASE = "https://app.example.test";
const USER = "u1";
const EMAIL = "racer@example.test";
const OLD_PASSWORD = "old-password-12345";
const NEW_PASSWORD = "new-password-67890";
const ATTACKER_PASSWORD = "attacker-password-24680";

/** A pause point: code under test `wait()`s there until the test `release()`s it. */
function pausePoint() {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release,
    wait: async () => {
      reach();
      await released;
    },
  };
}

/** Where a test pauses Better-Auth. Each is consumed once. */
const stage: {
  afterHashVerify?: () => Promise<void>;
  beforeSessionInsert?: () => Promise<void>;
  beforeResetSweep?: () => Promise<void>;
  beforeSessionDelete?: () => Promise<void>;
  beforePasswordWrite?: () => Promise<void>;
} = {};
const take = (key: keyof typeof stage) => {
  const hook = stage[key];
  delete stage[key];
  return hook?.();
};

let otp = "";
let fenceDisabled = false;

// Like the template's Prisma adapter (no transactions): every write commits as it
// happens. Session inserts and password writes can be paused.
const nonTransactional = ((adapterOptions: Parameters<ReturnType<typeof memoryAdapter>>[0]) => {
  const inner = memoryAdapter(tables.db)(adapterOptions);
  const adapter: typeof inner = new Proxy(inner, {
    get(target, key, receiver) {
      if (key === "transaction") return (work: (trx: typeof inner) => unknown) => work(adapter);
      const value = Reflect.get(target, key, receiver);
      if (typeof value !== "function") return value;
      return async (args: { model: string }) => {
        if (key === "create" && args.model === "session") await take("beforeSessionInsert");
        if (key === "deleteMany" && args.model === "session") await take("beforeSessionDelete");
        if ((key === "update" || key === "updateMany") && args.model === "account") {
          await take("beforePasswordWrite");
        }
        return Reflect.apply(value, target, [args]);
      };
    },
  });
  return adapter;
}) as ReturnType<typeof memoryAdapter>;

const auth = betterAuth({
  baseURL: BASE,
  secret: "disposable-unit-test-secret-with-no-external-use",
  database: nonTransactional,
  rateLimit: { enabled: false },
  logger: { disabled: true },
  emailAndPassword: {
    enabled: true,
    revokeSessionsOnPasswordReset: true,
    onPasswordReset: async ({ user }) => revokeCredentialsAfterPasswordReset(user.id),
    password: {
      hash: hashPassword,
      verify: async (data) => {
        const ok = await verifyPassword(data);
        await take("afterHashVerify");
        return ok;
      },
    },
  },
  plugins: [
    twoFactor({
      otpOptions: {
        storeOTP: "hashed",
        sendOTP: async ({ otp: code }) => {
          otp = code;
        },
      },
    }),
  ],
  // The wiring index.ts uses.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/reset-password") await take("beforeResetSweep");
      if (ctx.path === "/reset-password") {
        const token = ctx.body?.token || ctx.query?.token;
        const verification =
          token &&
          (await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`));
        if (verification && verification.expiresAt >= new Date())
          await revokeCredentialsAfterPasswordReset(verification.value);
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      const target = passwordChangeRevocationTarget({
        path: ctx.path,
        body: ctx.body,
        returned: ctx.context.returned,
      });
      if (target) await revokeCredentialsAfterPasswordChange(target);
    }),
  },
  databaseHooks: {
    account: {
      create: {
        before: async (account, context) => writeLock.guardPasswordAccountCreate(account, context),
        after: async () => writeLock.confirmPasswordWriteLocked(),
      },
      update: {
        before: async (data) => writeLock.guardPasswordAccountUpdate(data),
        after: async () => writeLock.confirmPasswordWriteLocked(),
      },
    },
    session: {
      create: {
        before: async (session, context) => {
          if (!fenceDisabled) await fence.fencePasswordSessionBefore(session, context);
        },
        after: async (session, context) => {
          if (!fenceDisabled) await fence.fencePasswordSessionAfter(session, context);
        },
      },
    },
    verification: {
      create: {
        after: async (verification, context) =>
          fence.recordTwoFactorChallenge(verification, context),
      },
    },
  },
});

function post(path: string, body: unknown, cookie = "") {
  return new Request(`${BASE}/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

/** How many times a password-write request reached the Better-Auth handler. */
let passwordWriteHandlerRuns = 0;

/** What apps/server does for a POST below /api/auth. */
function send(path: string, body: unknown, cookie = "") {
  const request = post(path, body, cookie);
  if (path === "/sign-in/email" && !fenceDisabled) {
    return fence.withPasswordSignInFence(request, () => auth.handler(request));
  }
  if (writeLock.PASSWORD_WRITE_PATHS.has(path)) {
    return writeLock.withPasswordWriteLock(
      path,
      request,
      () => {
        passwordWriteHandlerRuns += 1;
        return auth.handler(request);
      },
      { getSession: (headers) => auth.api.getSession({ headers }) },
    );
  }
  return auth.handler(request);
}

function signIn(password: string) {
  return send("/sign-in/email", { email: EMAIL, password });
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .filter((c) => !c?.endsWith("="))
    .join("; ");
}

let resetSeq = 0;
/** A complete Forgot-password reset to `password`, through the real handler. */
async function reset(password = NEW_PASSWORD) {
  resetSeq += 1;
  const token = `reset-token-${resetSeq}`;
  tables.db.verification?.push({
    id: `v-reset-${resetSeq}`,
    identifier: `reset-password:${token}`,
    value: USER,
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const res = await send("/reset-password", { token, newPassword: password });
  expect(res.status).toBe(200);
}

const sessionsOf = () => (tables.db.session ?? []).filter((s) => s.userId === USER);

async function seed({ twoFactorEnabled = false } = {}) {
  const now = new Date();
  // In place: the memory adapter holds this very object.
  for (const key of Object.keys(tables.db)) delete tables.db[key];
  Object.assign(tables.db, {
    user: [
      {
        id: USER,
        email: EMAIL,
        name: "Racer",
        emailVerified: true,
        twoFactorEnabled,
        createdAt: now,
        updatedAt: now,
      },
    ],
    account: [
      {
        id: "a1",
        userId: USER,
        accountId: USER,
        providerId: "credential",
        password: await hashPassword(OLD_PASSWORD),
        createdAt: now,
        updatedAt: now,
      },
    ],
    session: [],
    verification: [],
    twoFactor: [],
    apikey: [],
    deviceCode: [],
  });
}

let log: ReturnType<typeof captureLog>;
beforeEach(async () => {
  log = captureLog();
  for (const key of Object.keys(stage)) delete stage[key as keyof typeof stage];
  fenceDisabled = false;
  otp = "";
  passwordWriteHandlerRuns = 0;
  tables.locks.clear();
  tables.expireTransactions.length = 0;
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await seed();
});
afterEach(() => log.restore());

// Every case pays several real scrypt hashes.
describe("password sign-in vs password reset (real Better-Auth handler)", {
  timeout: 30_000,
}, () => {
  it("a normal sign-in mints a working session", async () => {
    const res = await signIn(OLD_PASSWORD);
    expect(res.status).toBe(200);
    expect(sessionsOf()).toHaveLength(1);
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookiesOf(res) }) });
    expect(session?.user.id).toBe(USER);
  });

  it("a reset that completes while the old hash is being verified leaves no session", async () => {
    const insert = vi.fn(async () => {});
    stage.beforeSessionInsert = insert;
    const pause = pausePoint();
    stage.afterHashVerify = pause.wait;
    const pending = signIn(OLD_PASSWORD);
    await pause.reached;
    await reset();
    pause.release();

    const res = await pending;
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(sessionsOf()).toHaveLength(0);
    expect(insert).not.toHaveBeenCalled();
  });

  it("a reset that completes after the fence check but before the insert: the session is removed", async () => {
    const pause = pausePoint();
    stage.beforeSessionInsert = pause.wait;
    const pending = signIn(OLD_PASSWORD);
    await pause.reached;
    await reset();
    pause.release();

    const res = await pending;
    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(sessionsOf()).toHaveLength(0);
    expect(log.records).toEqual([
      {
        level: "warn",
        site: "auth.password-sign-in-stale",
        message:
          "password sign-in completed after the password changed; its session and challenges were removed",
      },
    ]);
    expect(validateLogRecord(log.records[0])).toEqual(log.records[0]);
    for (const privateValue of [USER, EMAIL, OLD_PASSWORD, NEW_PASSWORD]) {
      expect(JSON.stringify(log.records)).not.toContain(privateValue);
    }
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("a sign-in that lands between the reset's session delete and its password write is deleted by the revocation", async () => {
    const pause = pausePoint();
    stage.beforePasswordWrite = pause.wait;
    const resetting = reset();
    await pause.reached;
    // Still the old hash: the fence cannot tell, so the sign-in succeeds…
    expect((await signIn(OLD_PASSWORD)).status).toBe(200);
    expect(sessionsOf()).toHaveLength(1);
    pause.release();
    await resetting;
    // …and the revocation after the password write deletes it.
    expect(sessionsOf()).toHaveLength(0);
  });

  it("after a completed reset the new password signs in and the old one does not", async () => {
    await reset();
    expect((await signIn(OLD_PASSWORD)).status).toBe(401);
    const res = await signIn(NEW_PASSWORD);
    expect(res.status).toBe(200);
    expect(sessionsOf()).toHaveLength(1);
  });

  it("mutation check: without the fence, the raced sign-in keeps a session", async () => {
    fenceDisabled = true;
    const pause = pausePoint();
    stage.afterHashVerify = pause.wait;
    const pending = signIn(OLD_PASSWORD);
    await pause.reached;
    await reset();
    pause.release();
    expect((await pending).status).toBe(200);
    expect(sessionsOf()).toHaveLength(1);
  });
});

describe("two-factor sign-in vs password reset (real Better-Auth handler)", {
  timeout: 30_000,
}, () => {
  beforeEach(() => seed({ twoFactorEnabled: true }));

  /** The password step: returns the two-factor challenge cookie. */
  async function passwordStep() {
    const res = await signIn(OLD_PASSWORD);
    expect(res.status).toBe(200);
    expect(await res.clone().json()).toMatchObject({ twoFactorRedirect: true });
    expect(sessionsOf()).toHaveLength(0);
    const cookie = cookiesOf(res);
    expect((await auth.handler(post("/two-factor/send-otp", {}, cookie))).status).toBe(200);
    expect(otp).toMatch(/^\d+$/);
    return cookie;
  }

  it.each([false, true])(
    "SSO's real-plugin 2FA challenge is credential-bound (reset: %s)",
    async (resetBeforeCode) => {
      // The app runs this same plugin after its verified SSO callback, outside
      // a password-request fence. Exercise that recorder context and real OTP step.
      fenceDisabled = true;
      const response = await auth.handler(
        post("/sign-in/email", { email: EMAIL, password: OLD_PASSWORD }),
      );
      fenceDisabled = false;
      expect(response.status).toBe(200);
      const challenge = tables.db.verification!.find((row) =>
        /^2fa-(?!attempts-)[A-Za-z0-9_-]+$/.test(String(row.identifier)),
      )!;
      expect(challenge).toBeDefined();
      await fence.recordTwoFactorChallenge(
        {
          identifier: String(challenge.identifier),
          value: USER,
          expiresAt: challenge.expiresAt as Date,
        },
        { path: "/callback/sso" },
      );
      expect(
        tables.db.verification!.filter((row) => String(row.identifier).includes(":credential:")),
      ).toHaveLength(1);
      const cookie = cookiesOf(response);
      expect((await auth.handler(post("/two-factor/send-otp", {}, cookie))).status).toBe(200);
      if (resetBeforeCode) await reset();
      const completed = await auth.handler(post("/two-factor/verify-otp", { code: otp }, cookie));
      expect(completed.status).toBe(resetBeforeCode ? 401 : 200);
      expect(sessionsOf()).toHaveLength(resetBeforeCode ? 0 : 1);
    },
  );

  it("a normal two-factor sign-in completes", async () => {
    const cookie = await passwordStep();
    const res = await auth.handler(post("/two-factor/verify-otp", { code: otp }, cookie));
    expect(res.status).toBe(200);
    expect(sessionsOf()).toHaveLength(1);
    // The challenge's credential fence row is spent with it.
    expect(tables.db.verification?.some((v) => String(v.identifier).includes(":credential:"))).toBe(
      false,
    );
  });

  it("a password step passed before a reset cannot be finished after it", async () => {
    const cookie = await passwordStep();
    // The production recorder created a fence alongside the plugin's rows;
    // reset must remove that metadata from the shared fixture too.
    expect(
      tables.db.verification?.filter((v) => String(v.identifier).includes(":credential:")),
    ).toHaveLength(1);
    await reset();
    expect(
      tables.db.verification?.filter((v) => /^(2fa-|trust-device-)/.test(String(v.identifier))),
    ).toEqual([]);
    const res = await auth.handler(post("/two-factor/verify-otp", { code: otp }, cookie));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(sessionsOf()).toHaveLength(0);
  });

  it("a reset that lands while the code step inserts its session: the session is removed", async () => {
    const cookie = await passwordStep();
    const pause = pausePoint();
    stage.beforeSessionInsert = pause.wait;
    const pending = auth.handler(post("/two-factor/verify-otp", { code: otp }, cookie));
    await pause.reached;
    await reset();
    pause.release();

    const res = await pending;
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(
      res.headers
        .getSetCookie()
        .some((c) => c.includes("session_token=") && !c.includes("session_token=;")),
    ).toBe(false);
    expect(sessionsOf()).toHaveLength(0);
  });

  it("a challenge with no credential fence row (opened outside the fence) is refused", async () => {
    const cookie = await passwordStep();
    tables.db.verification = (tables.db.verification ?? []).filter(
      (v) => !String(v.identifier).includes(":credential:"),
    );
    const res = await auth.handler(post("/two-factor/verify-otp", { code: otp }, cookie));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(sessionsOf()).toHaveLength(0);
  });
});

describe("fence hooks outside a fenced request", () => {
  it("refuses a password sign-in session without this request's fence", async () => {
    await expect(
      fence.fencePasswordSessionBefore({ userId: USER }, { path: "/sign-in/email" }),
    ).rejects.toThrow(/credential fence is missing/);
  });

  it("lets a two-factor step that rotates a live signed-in session through, and refuses one whose session is gone", async () => {
    tables.db.session = [{ id: "s-live", userId: USER, token: "t" }];
    const context = {
      path: "/two-factor/verify-totp",
      context: { session: { session: { id: "s-live", userId: USER } } },
    };
    await expect(
      fence.fencePasswordSessionBefore({ userId: USER }, context),
    ).resolves.toBeUndefined();
    tables.db.session = [];
    await expect(fence.fencePasswordSessionBefore({ userId: USER }, context)).rejects.toThrow(
      /Session refused/,
    );
  });

  it("lets an identity-provider sign-in through and refuses a parentless session anywhere else", async () => {
    for (const path of ["/callback/sso", "/callback/:id", "/sign-in/social"]) {
      await expect(
        fence.fencePasswordSessionBefore({ userId: USER }, { path }),
      ).resolves.toBeUndefined();
    }
    for (const context of [
      { path: "/verify-email" },
      { path: "/sign-up/email" },
      { path: "/Sign-In/Email" },
      { path: "/two-factor/enable" },
      null,
    ]) {
      await expect(fence.fencePasswordSessionBefore({ userId: USER }, context)).rejects.toThrow(
        /Session refused/,
      );
    }
  });

  it("a session derived from a live parent passes whoever it is for (impersonation)", async () => {
    tables.db.session = [{ id: "s-admin", userId: "admin", token: "t" }];
    const context = {
      path: "/admin/impersonate-user",
      context: { session: { session: { id: "s-admin", userId: "admin" } } },
    };
    await expect(
      fence.fencePasswordSessionBefore({ userId: USER }, context),
    ).resolves.toBeUndefined();
    await expect(
      fence.fencePasswordSessionAfter({ id: "s-new", userId: USER }, context),
    ).resolves.toBeUndefined();
  });

  it("refuses a password-change session outside the password-write lock", async () => {
    await expect(
      fence.fencePasswordSessionBefore({ userId: USER }, { path: "/change-password" }),
    ).rejects.toThrow(/password-write lock/);
    tables.db.session = [{ id: "s-new", userId: USER, token: "t" }];
    await expect(
      fence.fencePasswordSessionAfter({ id: "s-new", userId: USER }, { path: "/change-password" }),
    ).rejects.toThrow(/Session refused/);
    expect(sessionsOf()).toHaveLength(0);
  });
});

describe("credential snapshot query count", () => {
  const run = async () => new Response("handler");
  const snapshotQueries = async (body: unknown) => {
    tables.queries.length = 0;
    await fence.withPasswordSignInFence(post("/sign-in/email", body), run);
    return [...tables.queries];
  };

  it("does the same single query for an existing and a missing account", async () => {
    const existing = await snapshotQueries({ email: EMAIL, password: OLD_PASSWORD });
    const missing = await snapshotQueries({ email: "nobody@example.test", password: OLD_PASSWORD });
    expect(existing).toEqual(["account.findFirst"]);
    expect(missing).toEqual(existing);
  });

  it.each([
    [{ email: EMAIL }],
    [{ email: EMAIL, password: "" }],
    [{ email: EMAIL, password: 7 }],
    [{ email: EMAIL, password: "x".repeat(129) }],
    [{ email: "not-an-email", password: OLD_PASSWORD }],
    [{ password: OLD_PASSWORD }],
  ])("does no query for a body Better-Auth refuses before its lookup: %j", async (body) => {
    expect(await snapshotQueries(body)).toEqual([]);
  });

  it("fences a mixed-case form sign-in (correct credentials still sign in)", async () => {
    const request = new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "Application/X-WWW-Form-Urlencoded; Charset=UTF-8", origin: BASE },
      body: new URLSearchParams({ email: EMAIL, password: OLD_PASSWORD }).toString(),
    });
    const res = await fence.withPasswordSignInFence(request, () => auth.handler(request));
    expect(res.status).toBe(200);
    expect(sessionsOf()).toHaveLength(1);
  });
});

/** A signed-in browser for the user: its cookie and session id. */
async function signedIn() {
  const res = await signIn(OLD_PASSWORD);
  expect(res.status).toBe(200);
  return cookiesOf(res);
}

/** Whether a response set a live session cookie. */
const setsSession = (res: Response) =>
  res.headers.getSetCookie().some((c) => /session_token=[^;]/.test(c));

const passwordWorks = async (password: string) => {
  const res = await signIn(password);
  return res.status === 200;
};

describe("session rotations vs password reset (real Better-Auth handler)", {
  timeout: 30_000,
}, () => {
  const endpoints = [
    ["/two-factor/enable", { password: OLD_PASSWORD, method: "otp" }],
    ["/two-factor/disable", { password: OLD_PASSWORD }],
  ] as const;

  it.each(endpoints)("%s rotates the session normally", async (path, body) => {
    const cookie = await signedIn();
    const res = await send(path, body, cookie);
    expect(res.status).toBe(200);
    expect(sessionsOf()).toHaveLength(1);
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookiesOf(res) }) });
    expect(session?.user.id).toBe(USER);
  });

  it.each(endpoints)(
    "%s: a reset during its password check leaves no session",
    async (path, body) => {
      const cookie = await signedIn();
      const pause = pausePoint();
      stage.afterHashVerify = pause.wait;
      const pending = send(path, body, cookie);
      await pause.reached;
      await reset();
      pause.release();

      const res = await pending;
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(setsSession(res)).toBe(false);
      expect(sessionsOf()).toHaveLength(0);
    },
  );

  it.each(endpoints)(
    "%s: a reset after the before-check, before the insert: the session is removed",
    async (path, body) => {
      const cookie = await signedIn();
      const pause = pausePoint();
      stage.beforeSessionInsert = pause.wait;
      const pending = send(path, body, cookie);
      await pause.reached;
      await reset();
      pause.release();

      const res = await pending;
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(setsSession(res)).toBe(false);
      expect(sessionsOf()).toHaveLength(0);
    },
  );
});

describe("password change vs password reset (real Better-Auth handler)", {
  timeout: 30_000,
}, () => {
  const change = (cookie: string, revokeOtherSessions?: boolean) =>
    send(
      "/change-password",
      { currentPassword: OLD_PASSWORD, newPassword: ATTACKER_PASSWORD, revokeOtherSessions },
      cookie,
    );

  it("a change that signs out other devices keeps only the session it issues", async () => {
    const other = await signedIn();
    const cookie = await signedIn();
    const res = await change(cookie, true);
    expect(res.status).toBe(200);
    expect(sessionsOf()).toHaveLength(1);
    const mine = await auth.api.getSession({ headers: new Headers({ cookie: cookiesOf(res) }) });
    expect(mine?.user.id).toBe(USER);
    expect(await auth.api.getSession({ headers: new Headers({ cookie: other }) })).toBeNull();
    expect(await passwordWorks(ATTACKER_PASSWORD)).toBe(true);
  });

  it("a change that keeps other devices keeps every session", async () => {
    await signedIn();
    const cookie = await signedIn();
    expect((await change(cookie)).status).toBe(200);
    expect(sessionsOf()).toHaveLength(2);
    expect(await passwordWorks(OLD_PASSWORD)).toBe(false);
    expect(await passwordWorks(ATTACKER_PASSWORD)).toBe(true);
  });

  it("a reset that arrives while a change verifies the old password waits, then wins", async () => {
    const cookie = await signedIn();
    const pause = pausePoint();
    stage.afterHashVerify = pause.wait;
    const changing = change(cookie, true);
    await pause.reached;
    let resetDone = false;
    const resetting = reset().then(() => {
      resetDone = true;
    });
    // The reset is parked on the change's password-write lock.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(resetDone).toBe(false);
    pause.release();

    expect((await changing).status).toBe(200);
    await resetting;
    // The reset's password is the last write and its revocation took every session.
    expect(sessionsOf()).toHaveLength(0);
    expect(await passwordWorks(ATTACKER_PASSWORD)).toBe(false);
    expect(await passwordWorks(NEW_PASSWORD)).toBe(true);
  });

  it("a change whose session a reset deleted while it waited for the lock writes nothing", async () => {
    const cookie = await signedIn();
    const pause = pausePoint();
    stage.beforeResetSweep = pause.wait;
    const resetting = reset();
    await pause.reached;
    // The session still exists, so the change resolves its user, then waits.
    const changing = change(cookie, true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    pause.release();
    await resetting;

    const res = await changing;
    expect(res.status).toBe(401);
    expect(setsSession(res)).toBe(false);
    expect(passwordWriteHandlerRuns).toBe(1); // the reset's only
    expect(sessionsOf()).toHaveLength(0);
    expect(await passwordWorks(ATTACKER_PASSWORD)).toBe(false);
    expect(await passwordWorks(NEW_PASSWORD)).toBe(true);
  });

  it("refuses a password write that reaches Better-Auth without the lock", async () => {
    const cookie = await signedIn();
    const res = await auth.handler(
      post(
        "/change-password",
        { currentPassword: OLD_PASSWORD, newPassword: ATTACKER_PASSWORD },
        cookie,
      ),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await passwordWorks(ATTACKER_PASSWORD)).toBe(false);
    expect(await passwordWorks(OLD_PASSWORD)).toBe(true);
  });

  const credentialHash = () =>
    (tables.db.account ?? []).find((a) => a.userId === USER && a.providerId === "credential")
      ?.password;

  it("a change whose UPDATE lands after its lock timed out and a reset completed: credential scrambled, no session, request fails", async () => {
    const other = await signedIn();
    const cookie = await signedIn();
    const pause = pausePoint();
    // Past the account before-hook: the UPDATE is "on another connection".
    stage.beforePasswordWrite = pause.wait;
    const changing = change(cookie, true);
    await pause.reached;
    // Prisma times the lock transaction out; a reset elsewhere then completes.
    for (const expire of [...tables.expireTransactions]) expire();
    await reset();
    const resetHash = credentialHash();
    pause.release();

    const res = await changing;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "PASSWORD_WRITE_UNCONFIRMED" });
    expect(setsSession(res)).toBe(false);
    // Neither the racing change's hash nor the reset's survives.
    expect(credentialHash()).not.toBe(resetHash);
    expect(sessionsOf()).toHaveLength(0);
    expect(await auth.api.getSession({ headers: new Headers({ cookie: other }) })).toBeNull();
    expect(await passwordWorks(ATTACKER_PASSWORD)).toBe(false);
    expect(await passwordWorks(NEW_PASSWORD)).toBe(false);
    expect(await passwordWorks(OLD_PASSWORD)).toBe(false);
    // Forgot password recovers the account.
    await reset("recovered-password-13579");
    expect(await passwordWorks("recovered-password-13579")).toBe(true);
  });

  it("a write whose held flag lapsed (transaction still open) is quarantined too", async () => {
    const cookie = await signedIn();
    const pause = pausePoint();
    stage.beforePasswordWrite = pause.wait;
    const changing = change(cookie);
    await pause.reached;
    // 26 s later: past the 25 s held window, before Prisma's 30 s timeout.
    const now = performance.now();
    vi.spyOn(performance, "now").mockImplementation(() => now + 26_000);
    pause.release();

    const res = await changing;
    expect(res.status).toBe(409);
    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(sessionsOf()).toHaveLength(0);
    expect(await passwordWorks(ATTACKER_PASSWORD)).toBe(false);
    expect(await passwordWorks(OLD_PASSWORD)).toBe(false);
  });

  it("a reset whose UPDATE lands after its lock timed out is quarantined", async () => {
    const pause = pausePoint();
    stage.beforePasswordWrite = pause.wait;
    resetSeq += 1;
    const token = `reset-token-${resetSeq}`;
    tables.db.verification?.push({
      id: `v-reset-${resetSeq}`,
      identifier: `reset-password:${token}`,
      value: USER,
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const resetting = send("/reset-password", { token, newPassword: ATTACKER_PASSWORD });
    await pause.reached;
    for (const expire of [...tables.expireTransactions]) expire();
    pause.release();
    const res = await resetting;
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await passwordWorks(ATTACKER_PASSWORD)).toBe(false);
    expect(await passwordWorks(OLD_PASSWORD)).toBe(false);
    expect(sessionsOf()).toHaveLength(0);
  });

  it("answers 503 PASSWORD_WRITE_BUSY when the lock stays busy past the wait", async () => {
    const cookie = await signedIn();
    tables.locks.add(writeLock.passwordWriteLockKey(USER));
    const request = post(
      "/change-password",
      { currentPassword: OLD_PASSWORD, newPassword: ATTACKER_PASSWORD },
      cookie,
    );
    const res = await writeLock.withPasswordWriteLock(
      "/change-password",
      request,
      () => auth.handler(request),
      { getSession: (headers) => auth.api.getSession({ headers }), waitMs: 120 },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "PASSWORD_WRITE_BUSY" });
    tables.locks.clear();
    expect(await passwordWorks(OLD_PASSWORD)).toBe(true);
  });
});
