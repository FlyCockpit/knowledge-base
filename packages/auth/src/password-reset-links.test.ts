import { createHash } from "node:crypto";
import {
  configureLockSlots,
  releaseSlots,
  tryAcquireSlots,
  withLockSlot,
} from "@knowledge-base/db/lock-slots";
import { captureLog } from "@knowledge-base/env/log";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

configureLockSlots(3);

// Never a real DB: an in-memory verification table and user table, enough to
// see which rows a reset reads, writes and consumes, and in which order under
// which lock. The real-Postgres races are in
// password-reset-links.integration.test.ts.
type Row = { identifier: string; value: string; expiresAt: Date };
type User = {
  id: string;
  email: string;
  emailVerified: boolean;
  accounts?: { providerId: string }[];
  sessions?: { id: string }[];
};
const state = vi.hoisted(() => ({
  verifications: [] as Row[],
  users: [] as User[],
  /** Every statement in order, to see what ran under which lock. */
  calls: [] as string[],
  failTransactions: 0,
}));
const db = vi.hoisted(() => {
  const matches = (row: Row, where: Record<string, unknown>) => {
    if (typeof where.identifier === "string" && row.identifier !== where.identifier) return false;
    if (
      typeof where.identifier === "object" &&
      where.identifier !== null &&
      !row.identifier.startsWith((where.identifier as { startsWith: string }).startsWith)
    )
      return false;
    const not = (where.identifier as { not?: string } | undefined)?.not;
    if (typeof where.identifier === "object" && not !== undefined && row.identifier === not)
      return false;
    if (where.value !== undefined && row.value !== where.value) return false;
    const expiry = where.expiresAt as { gt: Date } | undefined;
    if (expiry && !(row.expiresAt > expiry.gt)) return false;
    return true;
  };
  const client = {
    verification: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        state.calls.push(`verification.findFirst ${String(where.identifier).split(":")[0]}`);
        return state.verifications.find((row) => matches(row, where)) ?? null;
      }),
      create: vi.fn(async ({ data }: { data: Row }) => {
        state.calls.push("verification.create");
        state.verifications.push(data);
        return { id: "v" };
      }),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        state.calls.push("verification.deleteMany");
        const before = state.verifications.length;
        state.verifications = state.verifications.filter((row) => !matches(row, where));
        return { count: before - state.verifications.length };
      }),
    },
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        state.calls.push("user.findUnique");
        const user = state.users.find((u) => u.id === where.id);
        if (!user) return null;
        return {
          emailVerified: user.emailVerified,
          accounts: user.accounts ?? [],
          sessions: user.sessions ?? [],
        };
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; email: string; emailVerified: boolean };
          data: { emailVerified: boolean };
        }) => {
          state.calls.push("user.updateMany");
          const hit = state.users.filter(
            (u) =>
              u.id === where.id &&
              u.email === where.email &&
              u.emailVerified === where.emailVerified,
          );
          for (const user of hit) user.emailVerified = data.emailVerified;
          return { count: hit.length };
        },
      ),
    },
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, key: string) => {
      state.calls.push(`lock ${key}`);
      return 1;
    }),
    $transaction: vi.fn(),
  };
  client.$transaction.mockImplementation(async (operation: unknown) => {
    if (state.failTransactions > 0) {
      state.failTransactions -= 1;
      throw new Error("connection lost");
    }
    if (Array.isArray(operation)) return Promise.all(operation);
    return (operation as (tx: unknown) => unknown)(client);
  });
  return client;
});
vi.mock("@knowledge-base/db", () => ({ default: db }));
vi.mock("@knowledge-base/db/authority-lock", () => ({
  lockIdentityAuthority: vi.fn(async () => {
    state.calls.push("lock authority");
  }),
}));

const {
  deleteResetLinksOnActivation,
  isResetLinkRedeemable,
  mintSetPasswordLink,
  recordResetLinkProof,
  resetTokenOf,
  SetPasswordLinkRefusedError,
} = await import("./password-reset-links");
const { admitResetSpend, isInvitePending } = await import("./reset-link-rules");

const now = new Date("2026-11-26T00:00:00Z");
const expiresAt = new Date("2026-12-01T00:00:00Z");
const SETUP_LOCK = "lock set-password-link:u1";
/** A reset link as Better Auth (or an invite) writes it. */
function link(token: string, userId = "u1", expires = expiresAt) {
  state.verifications.push({
    identifier: `reset-password:${token}`,
    value: userId,
    expiresAt: expires,
  });
}
const proofId = (token: string) =>
  `reset-password-proof:${createHash("sha256").update(token).digest("base64url")}`;
const resetRows = () =>
  state.verifications.filter((row) => row.identifier.startsWith("reset-password:"));

beforeEach(() => {
  // Calls that take the default clock see the same day as `now`, so the
  // fixtures (expiring 2026-12-01) stay valid whenever the suite runs.
  vi.useFakeTimers({ now, toFake: ["Date"] });
  vi.clearAllMocks();
  state.verifications = [];
  state.users = [{ id: "u1", email: "ada@example.com", emailVerified: false }];
  state.calls = [];
  state.failTransactions = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("isInvitePending", () => {
  const row = (over: Partial<Parameters<typeof isInvitePending>[0]>) => ({
    emailVerified: false,
    accounts: [],
    sessions: [],
    ...over,
  });
  it("is an unverified account with no account but at most a credential one, never signed in", () => {
    expect(isInvitePending(row({}))).toBe(true);
    expect(isInvitePending(row({ accounts: [{ providerId: "credential" }] }))).toBe(true);
    expect(isInvitePending(row({ emailVerified: true }))).toBe(false);
    expect(isInvitePending(row({ accounts: [{ providerId: "sso" }] }))).toBe(false);
    expect(
      isInvitePending(row({ accounts: [{ providerId: "credential" }, { providerId: "sso" }] })),
    ).toBe(false);
    expect(isInvitePending(row({ sessions: [{ id: "s" }] }))).toBe(false);
  });
});

describe("mintSetPasswordLink", () => {
  it("locks, re-reads the user, deletes older links, then writes the new one", async () => {
    link("old");
    const { token, expiresAt: until } = await mintSetPasswordLink({
      userId: "u1",
      ttlMs: 3_600_000,
      now,
    });
    expect(state.calls).toEqual([
      SETUP_LOCK,
      "user.findUnique",
      "verification.deleteMany",
      "verification.create",
    ]);
    expect(resetRows()).toEqual([
      { identifier: `reset-password:${token}`, value: "u1", expiresAt: until },
    ]);
    expect(until.getTime()).toBe(now.getTime() + 3_600_000);
    expect(token.length).toBeGreaterThanOrEqual(32);
  });

  it.each([
    ["verified", { emailVerified: true }],
    ["signed in", { sessions: [{ id: "s" }] }],
    ["SSO only", { accounts: [{ providerId: "sso" }] }],
  ])("refuses a user who is %s and writes nothing", async (_name, over) => {
    link("old");
    state.users = [{ id: "u1", email: "ada@example.com", emailVerified: false, ...over }];
    await expect(mintSetPasswordLink({ userId: "u1", ttlMs: 1000, now })).rejects.toBeInstanceOf(
      SetPasswordLinkRefusedError,
    );
    expect(resetRows().map((row) => row.identifier)).toEqual(["reset-password:old"]);
  });

  it("refuses a user that is gone", async () => {
    state.users = [];
    await expect(mintSetPasswordLink({ userId: "u1", ttlMs: 1000, now })).rejects.toBeInstanceOf(
      SetPasswordLinkRefusedError,
    );
  });
});

describe("recordResetLinkProof", () => {
  it("records beside the link under the lock, keyed by the token's hash, expiring with it", async () => {
    link("tok-1");
    expect(
      await recordResetLinkProof({
        token: "tok-1",
        userId: "u1",
        email: "Ada@Example.com",
        proof: "mailbox",
        now,
      }),
    ).toBe(true);
    expect(state.calls).toEqual([
      SETUP_LOCK,
      "verification.findFirst reset-password",
      "verification.create",
    ]);
    expect(state.verifications.find((row) => row.identifier === proofId("tok-1"))).toEqual({
      identifier: proofId("tok-1"),
      value: JSON.stringify({ userId: "u1", email: "ada@example.com", proof: "mailbox" }),
      expiresAt,
    });
    // The token itself is stored once only: in Better Auth's own row.
    expect(state.verifications.filter((row) => row.identifier.includes("tok-1"))).toHaveLength(1);
  });

  it("records nothing for a gone, expired or other user's link", async () => {
    const record = (token: string) =>
      recordResetLinkProof({
        token,
        userId: "u1",
        email: "ada@example.com",
        proof: "mailbox",
        now,
      });
    expect(await record("gone")).toBe(false);
    link("someone-else", "u2");
    expect(await record("someone-else")).toBe(false);
    link("expired", "u1", new Date("2026-11-25T00:00:00Z"));
    expect(await record("expired")).toBe(false);
    expect(
      state.verifications.some((row) => row.identifier.startsWith("reset-password-proof:")),
    ).toBe(false);
  });
});

describe("mintSetPasswordLink with a no-SMTP invite", () => {
  it("writes the no-SMTP proof in the same transaction as the link", async () => {
    const { token } = await mintSetPasswordLink({
      userId: "u1",
      ttlMs: 3_600_000,
      noSmtpInviteFor: "Ada@Example.com",
      now,
    });
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(state.verifications.find((row) => row.identifier === proofId(token))?.value).toBe(
      JSON.stringify({ userId: "u1", email: "ada@example.com", proof: "no-smtp-invite" }),
    );
  });
});

describe("admitResetSpend (inside Better Auth's spending transaction)", () => {
  const record = (token: string, proof: "mailbox" | "no-smtp-invite", email = "ada@example.com") =>
    recordResetLinkProof({ token, userId: "u1", email, proof, now });
  const AUTHORITY = "lock authority";

  it.each(["mailbox", "no-smtp-invite"] as const)(
    "a %s link is admitted, verifies, consumes its record and deletes only the other links",
    async (proof) => {
      link("spent");
      await record("spent", proof);
      link("other");
      state.calls = [];
      expect(await admitResetSpend(db as never, "spent", now)).toBe(true);
      expect(state.users[0]?.emailVerified).toBe(true);
      // Better Auth consumes "spent" itself right after this.
      expect(resetRows().map((row) => row.identifier)).toEqual(["reset-password:spent"]);
      expect(
        state.verifications.some((r) => r.identifier.startsWith("reset-password-proof:")),
      ).toBe(false);
      // Setup lock, then authority, before anything is decided or written.
      expect(state.calls.slice(0, 3)).toEqual([
        "verification.findFirst reset-password",
        SETUP_LOCK,
        AUTHORITY,
      ]);
      expect(state.calls.indexOf("user.updateMany")).toBeGreaterThan(
        state.calls.indexOf(AUTHORITY),
      );
    },
  );

  it("a link without a record (shown after a failed mail) is admitted while pending and verifies nothing", async () => {
    link("shown");
    link("other");
    expect(await admitResetSpend(db as never, "shown", now)).toBe(true);
    expect(state.users[0]?.emailVerified).toBe(false);
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(resetRows().map((row) => row.identifier)).toEqual(["reset-password:shown"]);
  });

  it.each([
    ["verified", { emailVerified: true }],
    ["signed in", { sessions: [{ id: "s" }] }],
    ["SSO-linked", { accounts: [{ providerId: "sso" }] }],
  ])(
    "refuses a shown or no-SMTP link once the account is %s, reading it under both locks",
    async (_name, over) => {
      Object.assign(state.users[0]!, over);
      link("shown");
      link("vouched");
      await record("vouched", "no-smtp-invite");
      for (const token of ["shown", "vouched"]) {
        state.calls = [];
        expect(await admitResetSpend(db as never, token, now)).toBe(false);
        expect(state.calls.indexOf(AUTHORITY)).toBeLessThan(state.calls.indexOf("user.findUnique"));
      }
      expect(db.user.updateMany).not.toHaveBeenCalled();
    },
  );

  it("admits a mailed link for an active account", async () => {
    state.users[0]!.emailVerified = true;
    link("mailed");
    await record("mailed", "mailbox");
    expect(await admitResetSpend(db as never, "mailed", now)).toBe(true);
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("verifies only the address the proof is for", async () => {
    link("tok");
    await record("tok", "mailbox", "old@example.com");
    expect(await admitResetSpend(db as never, "tok", now)).toBe(true);
    expect(state.users[0]?.emailVerified).toBe(false);
  });

  it("ignores another user's and a malformed record (then only the pending rule counts)", async () => {
    state.users[0]!.emailVerified = true;
    link("a");
    state.verifications.push({
      identifier: proofId("a"),
      value: JSON.stringify({ userId: "u2", email: "ada@example.com", proof: "mailbox" }),
      expiresAt,
    });
    expect(await admitResetSpend(db as never, "a", now)).toBe(false);
    link("b");
    state.verifications.push({ identifier: proofId("b"), value: "{not json", expiresAt });
    expect(await admitResetSpend(db as never, "b", now)).toBe(false);
  });

  it("leaves an unknown, expired or meanwhile deleted token to Better Auth's own consume", async () => {
    expect(await admitResetSpend(db as never, "unknown", now)).toBe(true);
    link("expired", "u1", new Date("2026-11-25T00:00:00Z"));
    state.users[0]!.emailVerified = true;
    expect(await admitResetSpend(db as never, "expired", now)).toBe(true);
    link("gone");
    db.$executeRaw.mockImplementationOnce(async () => {
      state.calls.push(SETUP_LOCK);
      state.verifications = state.verifications.filter(
        (r) => r.identifier !== "reset-password:gone",
      );
      return 1;
    });
    expect(await admitResetSpend(db as never, "gone", now)).toBe(true);
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });
});

describe("isResetLinkRedeemable", () => {
  const record = (token: string, proof: "mailbox" | "no-smtp-invite", userId = "u1") =>
    state.verifications.push({
      identifier: proofId(token),
      value: JSON.stringify({ userId, email: "ada@example.com", proof }),
      expiresAt,
    });

  it("a mailed link is spendable by an active account, with no lock", async () => {
    state.users[0]!.emailVerified = true;
    link("mailed");
    record("mailed", "mailbox");
    expect(await isResetLinkRedeemable("mailed")).toBe(true);
    expect(state.calls).not.toContain(SETUP_LOCK);
  });

  it.each([
    ["a shown link", undefined],
    ["a no-SMTP invite link", "no-smtp-invite"],
  ] as const)("%s is spendable while the invite is pending", async (_name, proof) => {
    link("tok");
    if (proof) record("tok", proof);
    expect(await isResetLinkRedeemable("tok")).toBe(true);
    expect(resetRows()).toHaveLength(1);
  });

  it.each([
    ["verified", { emailVerified: true }],
    ["signed in", { sessions: [{ id: "s" }] }],
    ["SSO-linked", { accounts: [{ providerId: "sso" }] }],
  ])(
    "refuses and deletes a shown link once the account is %s, reading it under the lock",
    async (_name, over) => {
      Object.assign(state.users[0]!, over);
      link("shown");
      record("shown-other", "no-smtp-invite");
      expect(await isResetLinkRedeemable("shown")).toBe(false);
      expect(resetRows()).toEqual([]);
      expect(state.calls.indexOf(SETUP_LOCK)).toBeLessThan(state.calls.indexOf("user.findUnique"));
      expect(state.calls.indexOf(SETUP_LOCK)).toBeGreaterThan(-1);
    },
  );

  it("a no-SMTP invite link dies with the invite too", async () => {
    state.users[0]!.emailVerified = true;
    link("tok");
    record("tok", "no-smtp-invite");
    expect(await isResetLinkRedeemable("tok")).toBe(false);
  });

  it("another user's or an expired mailbox record does not count", async () => {
    state.users[0]!.emailVerified = true;
    link("a");
    record("a", "mailbox", "u2");
    expect(await isResetLinkRedeemable("a")).toBe(false);
    link("b");
    state.verifications.push({
      identifier: proofId("b"),
      value: JSON.stringify({ userId: "u1", email: "ada@example.com", proof: "mailbox" }),
      expiresAt: new Date("2026-11-25T00:00:00Z"),
    });
    expect(await isResetLinkRedeemable("b")).toBe(false);
  });

  it("leaves unknown and expired tokens to Better Auth", async () => {
    expect(await isResetLinkRedeemable("unknown")).toBe(true);
    link("expired", "u1", new Date("2026-11-25T00:00:00Z"));
    state.users[0]!.emailVerified = true;
    expect(await isResetLinkRedeemable("expired")).toBe(true);
    expect(state.calls).not.toContain(SETUP_LOCK);
  });

  it("checks the record again under the lock", async () => {
    state.users[0]!.emailVerified = true;
    link("racing");
    // The record commits while this waits for the lock its writer holds.
    db.$executeRaw.mockImplementationOnce(async () => {
      state.calls.push(SETUP_LOCK);
      record("racing", "mailbox");
      return 1;
    });
    expect(await isResetLinkRedeemable("racing")).toBe(true);
    expect(resetRows()).toHaveLength(1);
  });
});

describe("deleteResetLinksOnActivation", () => {
  it("deletes every reset link of the user in one locked batch", async () => {
    link("a");
    link("b");
    link("c", "u2");
    await deleteResetLinksOnActivation("u1");
    expect(resetRows().map((row) => row.value)).toEqual(["u2"]);
    expect(state.calls).toEqual([SETUP_LOCK, "verification.deleteMany"]);
  });

  it("retries, then logs the user id and error class only and resolves", async () => {
    state.failTransactions = 3;
    const log = captureLog();
    const sleep = vi.fn(async () => {});
    try {
      await expect(deleteResetLinksOnActivation("u1", { sleep })).resolves.toBeUndefined();
    } finally {
      log.restore();
    }
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(log.records).toHaveLength(1);
    expect(log.records[0]).toMatchObject({
      site: "auth.reset-link-cleanup",
      userId: "u1",
      errorClass: "Error",
    });
    expect(JSON.stringify(log.records)).not.toContain("connection lost");
  });

  it("succeeds on a retry", async () => {
    link("a");
    state.failTransactions = 1;
    await deleteResetLinksOnActivation("u1", { sleep: async () => {} });
    expect(resetRows()).toEqual([]);
  });
});

describe("resetTokenOf", () => {
  it("reads the token of a POST /reset-password from the body or the query", () => {
    expect(resetTokenOf({ path: "/reset-password", body: { token: "b" } })).toBe("b");
    expect(resetTokenOf({ path: "/reset-password", body: {}, query: { token: "q" } })).toBe("q");
    expect(resetTokenOf({ path: "/reset-password", body: { token: "" } })).toBeNull();
    expect(resetTokenOf({ path: "/sign-in/email", body: { token: "b" } })).toBeNull();
  });
});

describe("reset-link transactions share central pool admission", () => {
  const operations = [
    ["mint", () => mintSetPasswordLink({ userId: "u1", ttlMs: 1000, now })],
    [
      "proof",
      () =>
        recordResetLinkProof({
          token: "tok",
          userId: "u1",
          email: "ada@example.com",
          proof: "mailbox",
          now,
        }),
    ],
    ["early check", () => isResetLinkRedeemable("tok", now)],
    ["activation cleanup", () => deleteResetLinksOnActivation("u1")],
  ] as const;

  it.each(operations)(
    "%s waits without starting a transaction when all slots are occupied",
    async (_name, run) => {
      link("tok");
      await withLockSlot(async () => {}); // initialize the central min-3 pool
      expect(tryAcquireSlots(2)).toBe(true);
      let pending: Promise<unknown> | undefined;
      try {
        pending = run();
        // Let the early check finish its unlocked reads before testing admission.
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
        expect(db.$transaction).not.toHaveBeenCalled();
        expect(state.calls).not.toContain(SETUP_LOCK);
      } finally {
        releaseSlots(2);
        await pending;
      }
      expect(db.$transaction).toHaveBeenCalledOnce();
    },
  );

  it("all helpers reuse a password writer's one reserved nested slot at pool minimum 3", async () => {
    await withLockSlot(
      async () => {
        expect(tryAcquireSlots()).toBe(false);
        const minted = await mintSetPasswordLink({ userId: "u1", ttlMs: 1000, now });
        expect(
          await recordResetLinkProof({
            token: minted.token,
            userId: "u1",
            email: "ada@example.com",
            proof: "no-smtp-invite",
            now,
          }),
        ).toBe(true);
        expect(await isResetLinkRedeemable(minted.token, now)).toBe(true);
        await deleteResetLinksOnActivation("u1");
        expect(resetRows()).toEqual([]);
        expect(tryAcquireSlots()).toBe(false);
      },
      { nested: 1 },
    );
    expect(tryAcquireSlots(2)).toBe(true);
    releaseSlots(2);
  });
});
