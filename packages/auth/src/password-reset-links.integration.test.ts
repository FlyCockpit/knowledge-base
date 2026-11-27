import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type KbPostgresDatabase,
  openKbPostgresClusterFromEnv,
} from "../../test-utils/src/kb/index.js";

// The real `auth` instance (index.ts: real Better Auth handler, hooks and
// bootstrap adapter) on a disposable Postgres, with the real advisory locks.
// Only env, mail and the Prisma client handle are swapped in.
const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));
const SECRET = "reset-links-fixture-secret-reset-links-fixture";
const db = vi.hoisted(() => ({ client: undefined as object | undefined }));

vi.mock("@knowledge-base/env/server", () => ({
  env: {
    NODE_ENV: "test",
    BETTER_AUTH_URL: "https://api.example.test",
    BETTER_AUTH_SECRET: new Secret("reset-links-fixture-secret-reset-links-fixture"),
    CORS_ORIGIN: undefined,
  },
  ADMIN_EMAIL: undefined,
  SIGNUP_ENABLED: true,
  SSO_ENABLED: false,
  FORCE_SSO: false,
}));
vi.mock("@knowledge-base/mailer", () => ({
  isEmailConfigured: () => false,
  renderResetPassword: () => ({ subject: "reset", html: "" }),
  renderTwoFactorOtp: () => ({ subject: "otp", html: "" }),
  renderVerifyEmail: () => ({ subject: "verify", html: "" }),
  sendEmail: async () => {},
}));
vi.mock("@knowledge-base/db", () => ({
  default: new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "then") return undefined;
        if (!db.client) throw new Error("no fixture client");
        const value: unknown = Reflect.get(db.client, prop);
        return typeof value === "function" ? value.bind(db.client) : value;
      },
    },
  ),
}));

const cluster = await openKbPostgresClusterFromEnv();
const database: KbPostgresDatabase = await cluster.createDatabase();
database.applyPrismaSchema();
const prisma = database.createPrismaClient("runtime");
// A second connection, to hold a lock while the code under test waits for it.
const holder = database.createPrismaClient("runtime");
db.client = prisma;

const { auth } = await import("./index");
const { handlePasswordAuthRequest } = await import("./password-auth-handler");
const links = await import("./password-reset-links");
const rules = await import("./reset-link-rules");

afterAll(async () => {
  await holder.$disconnect();
  await prisma.$disconnect();
  await database.close();
  await cluster.close();
});

const ORIGIN = "https://api.example.test";
const OLD_PASSWORD = "old-password-123456";

/** An invited account: unverified, no account row yet (users.invite). */
async function invitee(over: { emailVerified?: boolean } = {}) {
  return prisma.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      name: "Invitee",
      emailVerified: over.emailVerified ?? false,
    },
    select: { id: true, email: true },
  });
}

async function withPassword(userId: string, password = OLD_PASSWORD) {
  const context = await auth.$context;
  await prisma.account.create({
    data: {
      userId,
      accountId: userId,
      providerId: "credential",
      password: await context.password.hash(password),
    },
  });
}

async function spend(token: string, newPassword = "new-password-123456") {
  const res = await handlePasswordAuthRequest(
    auth,
    new Request(`${ORIGIN}/api/auth/reset-password`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ token, newPassword }),
    }),
  );
  return { status: res.status, body: (await res.json()) as { code?: string } };
}

async function passwordWorks(email: string, password: string) {
  const context = await auth.$context;
  const user = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { accounts: { where: { providerId: "credential" }, select: { password: true } } },
  });
  const hash = user.accounts[0]?.password;
  return !!hash && (await context.password.verify({ hash, password }));
}

const verified = async (id: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id }, select: { emailVerified: true } }))
    .emailVerified;
const resetRows = (userId: string) =>
  prisma.verification.count({
    where: { value: userId, identifier: { startsWith: rules.RESET_PASSWORD_IDENTIFIER_PREFIX } },
  });
const mint = (userId: string) => links.mintSetPasswordLink({ userId, ttlMs: 72 * 3_600_000 });

beforeEach(() => {
  db.client = prisma;
});

describe("reset and invite links against real Postgres and the real handler", () => {
  it("a mailed invite link sets the password and verifies; a shown one only sets the password", async () => {
    const mailed = await invitee();
    const link = await mint(mailed.id);
    await links.recordResetLinkProof({
      ...link,
      userId: mailed.id,
      email: mailed.email,
      proof: "mailbox",
    });
    expect((await spend(link.token)).status).toBe(200);
    expect(await verified(mailed.id)).toBe(true);
    expect(await resetRows(mailed.id)).toBe(0);

    const shown = await invitee();
    const shownLink = await mint(shown.id);
    expect((await spend(shownLink.token, "shown-password-123456")).status).toBe(200);
    expect(await verified(shown.id)).toBe(false);
    expect(await passwordWorks(shown.email, "shown-password-123456")).toBe(true);
    // Still a pending invite: a later mailed link verifies when spent.
    const again = await mint(shown.id);
    await links.recordResetLinkProof({
      ...again,
      userId: shown.id,
      email: shown.email,
      proof: "mailbox",
    });
    expect((await spend(again.token)).status).toBe(200);
    expect(await verified(shown.id)).toBe(true);
  });

  it("a no-SMTP invite link verifies, but only while the invite is pending", async () => {
    const user = await invitee();
    const link = await mint(user.id);
    await links.recordResetLinkProof({
      ...link,
      userId: user.id,
      email: user.email,
      proof: "no-smtp-invite",
    });
    expect((await spend(link.token)).status).toBe(200);
    expect(await verified(user.id)).toBe(true);
  });

  it("a forgot-password mail records its proof and verifies when spent", async () => {
    const user = await invitee();
    await withPassword(user.id);
    await auth.api.requestPasswordReset({
      body: { email: user.email, redirectTo: `${ORIGIN}/en-US/reset-password` },
    });
    const row = await prisma.verification.findFirstOrThrow({
      where: { value: user.id, identifier: { startsWith: "reset-password:" } },
    });
    const token = row.identifier.slice("reset-password:".length);
    expect((await spend(token)).status).toBe(200);
    expect(await verified(user.id)).toBe(true);
  });

  it("Postgres reset cleanup removes every owned 2FA proof, preserves peers and refuses a delayed challenge session", async () => {
    const user = await invitee();
    const peer = await invitee();
    await withPassword(user.id);
    const link = await mint(user.id);
    // This case intentionally creates an existing session below. Use a mailed
    // reset proof so the reset remains eligible after the invite becomes active.
    expect(
      await links.recordResetLinkProof({
        ...link,
        userId: user.id,
        email: user.email,
        proof: "mailbox",
      }),
    ).toBe(true);
    const { recordTwoFactorChallenge, fencePasswordSessionBefore, fencePasswordSessionAfter } =
      await import("./password-sign-in-fence");
    const expiresAt = new Date(Date.now() + 60_000);
    const challenge = `2fa-${randomUUID()}`;
    const secondChallenge = `2fa-${randomUUID()}`;
    const peerChallenge = `2fa-${randomUUID()}`;
    const orphan = `2fa-${randomUUID()}`;
    const oldToken = randomUUID();
    const peerToken = randomUUID();
    const target = [
      { identifier: challenge, value: user.id },
      { identifier: secondChallenge, value: user.id },
      { identifier: `2fa-attempts-${challenge}`, value: "2" },
      { identifier: `2fa-otp-${challenge}`, value: "hashed-target-otp" },
      { identifier: `2fa-attempts-${secondChallenge}`, value: "1" },
      { identifier: `2fa-otp-${secondChallenge}`, value: "hashed-second-otp" },
      { identifier: `trust-device-${randomUUID()}`, value: user.id },
      { identifier: `2fa-otp-${user.id}!${oldToken}`, value: "hashed-session-otp" },
    ];
    const controls = [
      { identifier: peerChallenge, value: peer.id },
      { identifier: `${peerChallenge}:credential:peer-fingerprint`, value: peer.id },
      { identifier: `2fa-attempts-${peerChallenge}`, value: "2" },
      { identifier: `2fa-otp-${peerChallenge}`, value: "hashed-peer-otp" },
      { identifier: `trust-device-${randomUUID()}`, value: peer.id },
      { identifier: `2fa-otp-${peer.id}!${peerToken}`, value: "hashed-peer-session-otp" },
      // Matching a user-id prefix is insufficient; the session delimiter matters.
      { identifier: `2fa-otp-${user.id}suffix!session-token`, value: "lookalike-owner" },
      // No owned parent: dependent-looking rows are not this user's proofs.
      { identifier: `2fa-attempts-${orphan}`, value: "3" },
      { identifier: `2fa-otp-${orphan}`, value: "unlinked-otp" },
      { identifier: `unrelated-${randomUUID()}`, value: user.id },
      { identifier: `trust-device-lookalike-${randomUUID()}`, value: `${user.id}suffix` },
    ];
    await prisma.verification.createMany({
      data: [...target, ...controls].map((row) => ({ ...row, expiresAt })),
    });
    // Use the production recorder for a real credential fingerprint. The SSO
    // context permits recording outside a password request's AsyncLocalStorage.
    await recordTwoFactorChallenge(
      { identifier: challenge, value: user.id, expiresAt },
      { path: "/callback/sso" },
    );
    const fingerprint = await prisma.verification.findFirstOrThrow({
      where: { value: user.id, identifier: { startsWith: `${challenge}:credential:` } },
      select: { identifier: true, value: true },
    });
    target.push(fingerprint);
    const identifiers = [...target, ...controls].map((row) => row.identifier);
    const rows = () =>
      prisma.verification.findMany({
        where: { identifier: { in: identifiers } },
        orderBy: { identifier: "asc" },
        take: identifiers.length,
        select: { identifier: true, value: true, expiresAt: true },
      });
    const before = await rows();
    expect(before).toHaveLength(identifiers.length);
    const expectedControls = before.filter((row) =>
      controls.some((control) => control.identifier === row.identifier),
    );
    const context = {
      path: "/two-factor/verify-otp",
      context: {
        secret: SECRET,
        createAuthCookie: () => ({ name: "two_factor" }),
      },
      getSignedCookie: async () => challenge,
    };
    // A code step passed its before-hook, but has not inserted its session yet.
    await expect(fencePasswordSessionBefore({ userId: user.id }, context)).resolves.toBeUndefined();
    const peerSession = await prisma.session.create({
      data: { userId: peer.id, token: peerToken, expiresAt },
    });
    const oldSession = await prisma.session.create({
      data: { userId: user.id, token: oldToken, expiresAt },
    });
    // Actual handler/reset hooks execute the production raw SQL on Postgres.
    expect((await spend(link.token)).status).toBe(200);
    expect(await rows(), "Postgres cleanup must remove only owned proofs").toEqual(
      expectedControls,
    );
    expect(await prisma.session.findUnique({ where: { id: oldSession.id } })).toBeNull();
    expect(await prisma.session.findUnique({ where: { id: peerSession.id } })).toEqual(peerSession);
    await expect(fencePasswordSessionBefore({ userId: user.id }, context)).rejects.toThrow(
      /Session refused/,
    );
    // The delayed insert commits after reset; the production after-hook must
    // remove it and refuse the request because its challenge proof was revoked.
    const delayed = await prisma.session.create({
      data: { userId: user.id, token: randomUUID(), expiresAt },
    });
    await expect(fencePasswordSessionAfter(delayed, context)).rejects.toThrow(/Session refused/);
    expect(await prisma.session.findUnique({ where: { id: delayed.id } })).toBeNull();
    expect(await rows(), "Postgres cleanup must remove only owned proofs").toEqual(
      expectedControls,
    );
  });

  it("a leftover shown link is dead once the account is active, cleanup or not", async () => {
    const user = await invitee();
    await withPassword(user.id);
    const leftover = await mint(user.id);
    // Activation through Better Auth (as verify-email writes it): the
    // after-hook deletes the user's reset links under the lock.
    const context = await auth.$context;
    await context.internalAdapter.updateUser(user.id, { emailVerified: true });
    expect(await resetRows(user.id)).toBe(0);
    expect((await spend(leftover.token)).body.code).toBe("INVALID_TOKEN");

    // As if that tidy-up had failed: the row is back, and redemption still
    // refuses it (and deletes it); the user's own password is unchanged.
    await prisma.verification.create({
      data: {
        identifier: `reset-password:${leftover.token}`,
        value: user.id,
        expiresAt: leftover.expiresAt,
      },
    });
    const refused = await spend(leftover.token);
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("INVALID_TOKEN");
    expect(await resetRows(user.id)).toBe(0);
    expect(await passwordWorks(user.email, OLD_PASSWORD)).toBe(true);
    // Minting for the active account is refused too.
    await expect(mint(user.id)).rejects.toBeInstanceOf(links.SetPasswordLinkRefusedError);
  });

  it("an IdP identity linked to the invite kills its link", async () => {
    const user = await invitee();
    const link = await mint(user.id);
    const context = await auth.$context;
    await context.internalAdapter.linkAccount({
      userId: user.id,
      providerId: "sso",
      accountId: `sso-${user.id}`,
    });
    expect(await resetRows(user.id)).toBe(0);
    expect((await spend(link.token)).body.code).toBe("INVALID_TOKEN");
    expect(await passwordWorks(user.email, "new-password-123456")).toBe(false);
  });

  /** Holds the user's credential-setup lock on a second connection until released. */
  async function holdSetupLock(userId: string) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const held = holder.$transaction(
      async (tx) => {
        await rules.lockCredentialSetup(tx, userId);
        locked();
        await released;
      },
      { timeout: 60_000 },
    );
    await isLocked;
    return async () => {
      release();
      await held;
    };
  }

  /** Waits until `count` sessions wait for an advisory lock (the ones the test holds). */
  async function waitingOnLocks(count: number) {
    for (let i = 0; i < 600; i++) {
      const rows = await prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_locks
         WHERE locktype = 'advisory' AND NOT granted AND database = (
           SELECT oid FROM pg_database WHERE datname = current_database())`;
      if (Number(rows[0]?.n ?? 0) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`fewer than ${count} sessions ever waited for the lock`);
  }

  it("a mint racing the invitee's own mailed reset leaves no working link", async () => {
    const user = await invitee();
    const link = await mint(user.id);
    await links.recordResetLinkProof({
      ...link,
      userId: user.id,
      email: user.email,
      proof: "mailbox",
    });
    const release = await holdSetupLock(user.id);
    // The mailed link passes the before-hook without a lock; Better Auth's
    // spending transaction then queues on the lock (admitResetSpend).
    const reset = spend(link.token, "invitee-password-123456");
    await waitingOnLocks(1);
    // An invite link minted now queues on the same lock.
    const minted = mint(user.id).then(
      (value) => value,
      (error: unknown) => error,
    );
    await waitingOnLocks(2);
    await release();
    const resetResult = await reset;
    const outcome = await minted;
    // Whichever took the lock first, no working link to an active account
    // is left: either the reset won (verified, and the mint was refused or its
    // link deleted), or the mint won (it replaced the mailed link, the reset
    // was refused and the invite is still pending with one working link).
    if (resetResult.status === 200) {
      expect(await verified(user.id)).toBe(true);
      expect(await resetRows(user.id)).toBe(0);
      expect(await passwordWorks(user.email, "invitee-password-123456")).toBe(true);
      if (!(outcome instanceof Error)) {
        expect((await spend((outcome as { token: string }).token)).body.code).toBe("INVALID_TOKEN");
      }
    } else {
      expect(resetResult.body.code).toBe("INVALID_TOKEN");
      expect(outcome).not.toBeInstanceOf(Error);
      expect(await verified(user.id)).toBe(false);
      expect(await resetRows(user.id)).toBe(1);
    }
  });

  it("a shown link spent with the invitee's mailed one never leaves a verified account with its password", async () => {
    for (const holdLock of [true, false, true]) {
      const user = await invitee();
      const shown = await mint(user.id);
      // A forgot-password mail for the same pending account (recorded as mailed).
      await auth.api.requestPasswordReset({
        body: { email: user.email, redirectTo: `${ORIGIN}/en-US/reset-password` },
      });
      const mailedRow = await prisma.verification.findFirstOrThrow({
        where: {
          value: user.id,
          identifier: { startsWith: "reset-password:", not: `reset-password:${shown.token}` },
        },
      });
      const mailed = mailedRow.identifier.slice("reset-password:".length);
      const release = holdLock ? await holdSetupLock(user.id) : null;
      const results = Promise.all([
        spend(mailed, "invitee-password-123456"),
        spend(shown.token, "holder-password-123456"),
      ]);
      if (release) {
        // The password-write lock serializes the HTTP spends. One reaches
        // setup admission while the other polls password-write; requiring two
        // PostgreSQL lock waiters would deadlock this test's release gate.
        // The direct transaction race below still tests atomic admission.
        await waitingOnLocks(1);
        await release();
      }
      const [invitee_, holder_] = await results;
      expect([200, 400]).toContain(invitee_.status);
      const holderSet = await passwordWorks(user.email, "holder-password-123456");
      const isVerified = await verified(user.id);
      // The invariant: a password set through the unproved link never sits on
      // a verified account. Either the invitee's password won and the account
      // is verified, or the holder's won and it stays unverified.
      expect(isVerified && holderSet).toBe(false);
      if (isVerified) expect(await passwordWorks(user.email, "invitee-password-123456")).toBe(true);
      if (holder_.status !== 200) expect(holder_.body.code).toBe("INVALID_TOKEN");
      expect(await resetRows(user.id)).toBe(0);
    }
  });

  it("a shown-link spend racing an activation that holds the authority lock is refused", async () => {
    const user = await invitee();
    const shown = await mint(user.id);
    // An activation (as /verify-email writes it: identity authority lock, then
    // emailVerified) that has not committed yet.
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let written!: () => void;
    const isWritten = new Promise<void>((resolve) => {
      written = resolve;
    });
    const { lockIdentityAuthority } = await import("@knowledge-base/db/authority-lock");
    const activation = holder.$transaction(
      async (tx) => {
        await lockIdentityAuthority(tx);
        await tx.user.update({ where: { id: user.id }, data: { emailVerified: true } });
        written();
        await released;
      },
      { timeout: 60_000 },
    );
    await isWritten;
    // The before-hook still reads "pending" (uncommitted); the spending
    // transaction then waits for the authority lock.
    const spent = spend(shown.token, "holder-password-123456");
    await waitingOnLocks(1);
    release();
    await activation;
    const result = await spent;
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("INVALID_TOKEN");
    expect(await verified(user.id)).toBe(true);
    expect(await passwordWorks(user.email, "holder-password-123456")).toBe(false);
  });

  it("the spending transaction's own check waits for an activation holding the authority lock", async () => {
    // Directly on Postgres, below the HTTP pipeline: the activation holds the
    // authority lock with emailVerified written but uncommitted; the spend's
    // admission takes the setup lock, waits on the authority lock, and then
    // sees the committed activation.
    const user = await invitee();
    const shown = await mint(user.id);
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let written!: () => void;
    const isWritten = new Promise<void>((resolve) => {
      written = resolve;
    });
    const { lockIdentityAuthority } = await import("@knowledge-base/db/authority-lock");
    const activation = holder.$transaction(
      async (tx) => {
        await lockIdentityAuthority(tx);
        await tx.user.update({ where: { id: user.id }, data: { emailVerified: true } });
        written();
        await released;
      },
      { timeout: 60_000 },
    );
    await isWritten;
    const admitted = prisma.$transaction((tx) => rules.admitResetSpend(tx, shown.token), {
      timeout: 60_000,
    });
    await waitingOnLocks(1);
    release();
    await activation;
    expect(await admitted).toBe(false);
  });

  it("refuses Better Auth's /admin/create-user over HTTP, even for a verified admin", async () => {
    const admin = await prisma.user.create({
      data: {
        email: `${randomUUID()}@example.test`,
        name: "Admin",
        emailVerified: true,
        role: "admin",
      },
    });
    const context = await auth.$context;
    // Seed the already authenticated admin; production refuses parentless
    // internal session creation outside a proved sign-in request.
    const session = await prisma.session.create({
      data: {
        userId: admin.id,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const signature = createHmac("sha256", SECRET).update(session.token).digest("base64");
    const email = `${randomUUID()}@example.test`;
    const res = await auth.handler(
      new Request(`${ORIGIN}/api/auth/admin/create-user`, {
        method: "POST",
        headers: {
          origin: ORIGIN,
          "content-type": "application/json",
          cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
        },
        body: JSON.stringify({
          email,
          name: "Chosen",
          password: "chosen-password-123456",
          data: { emailVerified: true },
        }),
      }),
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe("ADMIN_CREATE_USER_UNSUPPORTED");
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });
});
