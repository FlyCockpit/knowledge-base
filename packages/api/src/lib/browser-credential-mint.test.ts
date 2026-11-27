import { beforeEach, describe, expect, it, vi } from "vitest";
import { revokeCredentialsAfterPasswordReset } from "../../../auth/src/credential-revocation";
import { mintBrowserApiKey } from "./api-keys";
import type { LockQuery } from "./kb/lock";
import type { Runtime } from "./mcp-token-access";
import { mintBrowserPersonalToken } from "./mcp-token-access";

const db = vi.hoisted(() => ({ $transaction: vi.fn() }));
vi.mock("@knowledge-base/db", () => ({ default: db }));

const actor = { userId: "owner", sessionId: "cached-browser-session" };
const minting = [
  {
    name: "PAT",
    mint: (r: Runtime) =>
      mintBrowserPersonalToken(r, actor, {
        name: "test",
        scopes: ["mcp:read"],
        toolGroups: ["read"],
        acl: [],
      }),
  },
  {
    name: "API key",
    mint: (r: Runtime) =>
      mintBrowserApiKey(r, actor, { name: "test", reach: "created", bits: ["read"] }),
  },
];

/** A serialized authority transaction model. No DB or Redis IO. Both the real
 * revoker and the real browser mint bodies execute against the same state. */
function fixture() {
  const user = {
    id: actor.userId,
    role: "user",
    twoFactorEnabled: true,
    banned: false,
    createdAt: new Date(0),
  };
  let session: { userId: string; expiresAt: Date; impersonatedBy: string | null } | null = {
    userId: actor.userId,
    expiresAt: new Date(Date.now() + 60_000),
    impersonatedBy: null,
  };
  let tail = Promise.resolve();
  let held = false;
  let pause: (() => Promise<void>) | undefined;
  const grants: { id: string; revoked: boolean }[] = [];
  const statements: string[] = [];
  async function serialized<T>(run: () => Promise<T>): Promise<T> {
    const previous = tail;
    const done = Promise.withResolvers<void>();
    tail = done.promise;
    await previous;
    held = true;
    try {
      return await run();
    } finally {
      held = false;
      done.resolve();
    }
  }
  const query = (async (sql: string, params: unknown[] = []) => {
    expect(held).toBe(true);
    statements.push(sql);
    let rows: Record<string, unknown>[] = [];
    if (sql.includes('FROM "session"')) {
      // Assert the actual SQL boundary too: the fake must not hide a missing predicate.
      expect(sql).toContain('id = $1 AND "userId" = $2');
      expect(sql).toContain('"expiresAt" > clock_timestamp()');
      expect(sql).toContain('"impersonatedBy" IS NULL');
      if (
        params[0] === actor.sessionId &&
        params[1] === session?.userId &&
        session.expiresAt > new Date() &&
        session.impersonatedBy === null
      )
        rows = [{ id: actor.sessionId }];
      await pause?.();
    } else if (sql.includes('FROM "user"')) {
      rows = [user];
    } else if (sql.includes('INSERT INTO "mcp_grant"')) {
      grants.push({ id: String(params[0]), revoked: false });
    } else if (sql.includes("SELECT k.id")) {
      rows = [{ id: "key", reach: "CREATED", bits: ["read"], childAuthoringMode: null }];
    }
    return { rows, rowCount: rows.length };
  }) as LockQuery;
  const tx = {
    $executeRaw: vi.fn(async () => {
      expect(held).toBe(true);
      return 0;
    }),
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      expect(held).toBe(true);
      if (sql.includes('UPDATE "mcp_grant"')) for (const grant of grants) grant.revoked = true;
      return 1;
    }),
    deviceCode: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    session: {
      deleteMany: vi.fn(async ({ where }: { where: { userId: string } }) => {
        expect(held).toBe(true);
        expect(where).toEqual({ userId: actor.userId });
        session = null;
        return { count: 1 };
      }),
    },
  };
  db.$transaction.mockImplementation((run: (client: typeof tx) => Promise<unknown>) =>
    serialized(() => run(tx)),
  );
  const runtime = {
    canonicalOrigin: "https://kb.invalid",
    coordinator: {
      run: ({ kind, run }: { kind: string; run: (ctx: unknown) => Promise<unknown> }) => {
        expect(kind).toBe("authority");
        return serialized(() =>
          run({
            lease: { transaction: (work: (q: LockQuery) => Promise<unknown>) => work(query) },
          }),
        );
      },
    },
  } as unknown as Runtime;
  return {
    runtime,
    grants,
    statements,
    user,
    setSession: (value: typeof session) => {
      session = value;
    },
    pause: (work: () => Promise<void>) => {
      pause = work;
    },
  };
}

beforeEach(() => vi.clearAllMocks());
describe.each(minting)("$name browser mint", ({ mint }) => {
  it.each([
    { loss: "ban", sessionMissing: false },
    { loss: "ban", sessionMissing: true },
    { loss: "2fa", sessionMissing: false },
    { loss: "2fa", sessionMissing: true },
  ])(
    "preserves FORBIDDEN after $loss (session missing: $sessionMissing)",
    async ({ loss, sessionMissing }) => {
      const f = fixture();
      if (loss === "ban") f.user.banned = true;
      else {
        f.user.role = "admin";
        f.user.twoFactorEnabled = false;
      }
      if (sessionMissing) f.setSession(null);
      await expect(mint(f.runtime)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(f.grants).toHaveLength(0);
      expect(f.statements.some((sql) => sql.includes("INSERT"))).toBe(false);
    },
  );

  it.each(["missing", "wrong owner", "expired", "impersonated"])(
    "refuses a cookie-cache context whose DB session is %s",
    async (kind) => {
      const f = fixture();
      f.setSession(
        kind === "missing"
          ? null
          : {
              userId: kind === "wrong owner" ? "other" : actor.userId,
              expiresAt: new Date(kind === "expired" ? 0 : Date.now() + 60_000),
              impersonatedBy: kind === "impersonated" ? "admin" : null,
            },
      );
      await expect(mint(f.runtime)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      expect(f.grants).toHaveLength(0);
      expect(f.statements.some((sql) => sql.includes("INSERT"))).toBe(false);
    },
  );

  it("mint wins the lock: revocation waits for commit then revokes the new credential", async () => {
    const f = fixture();
    const checked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.pause(async () => {
      checked.resolve();
      await release.promise;
    });
    const minted = mint(f.runtime);
    await checked.promise;
    const reset = revokeCredentialsAfterPasswordReset(actor.userId);
    expect(f.grants).toHaveLength(0);
    release.resolve();
    await minted;
    await reset;
    expect(f.grants).toHaveLength(1);
    expect(f.grants[0]?.revoked).toBe(true);
  });

  it("reset wins the lock: a previously authorized in-flight browser request is refused", async () => {
    const f = fixture();
    // The browser context was resolved before reset; the mint has not acquired authority.
    const reset = revokeCredentialsAfterPasswordReset(actor.userId);
    const minted = mint(f.runtime);
    await expect(minted).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await reset;
    expect(f.grants).toHaveLength(0);
  });

  it("refuses a gap mint after the pre-sweep commits, without relying on the post-sweep", async () => {
    const f = fixture();
    await revokeCredentialsAfterPasswordReset(actor.userId);
    // Better Auth has not deleted sessions or run its post-sweep yet. Even if
    // that sweep fails, this old browser context must not create a credential.
    await expect(mint(f.runtime)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(f.grants).toHaveLength(0);
    expect(f.statements.some((sql) => sql.includes("INSERT"))).toBe(false);
  });
});
