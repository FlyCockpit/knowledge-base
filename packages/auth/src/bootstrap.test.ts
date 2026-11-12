import { afterEach, describe, expect, it, vi } from "vitest";
import { OWNED_ACTIVE_KB_BLOCK_MESSAGE } from "./account-deletion-policy";
import {
  adoptExistingUsers,
  BOOTSTRAP_STATE_ID,
  type BootstrapPolicy,
  createBootstrapDatabaseAdapter,
  DEFAULT_ROLE,
  decideUserCreate,
  FIRST_USER_ROLE,
  isAdminBootstrapSignupEnabled,
  isBootstrapComplete,
  isUserModel,
  lockBootstrapState,
  persistBootstrapAdoption,
  preserveRequestedRole,
  runBootstrappedUserCreate,
} from "./bootstrap";
import { canonicalizeEmail } from "./email";
import { runWithAdminMutationActor } from "./session-authority";
import { runWithAllowedUserCreation, SIGNUP_DISABLED_MESSAGE } from "./user-creation-policy";

const envState = vi.hoisted(() => ({
  NODE_ENV: "test",
  ADMIN_EMAIL: undefined as string | undefined,
  SIGNUP_ENABLED: false,
}));

vi.mock("@knowledge-base/env/server", () => ({
  env: envState,
  get ADMIN_EMAIL() {
    return envState.ADMIN_EMAIL;
  },
  get SIGNUP_ENABLED() {
    return envState.SIGNUP_ENABLED;
  },
}));

vi.mock("better-auth/adapters/prisma", () => ({
  prismaAdapter:
    (client: {
      insertUser: (data: Record<string, unknown>) => Promise<unknown>;
      deleteUser?: (args: { model: string; where: unknown }) => Promise<unknown>;
      deleteManyRows?: (args: { model: string; where: unknown }) => Promise<unknown>;
      updateRow?: (args: { model: string; where: unknown; update: unknown }) => Promise<unknown>;
    }) =>
    () => {
      const adapter = {
        create: async ({ model, data }: { model: string; data: Record<string, unknown> }) => {
          if (model !== "user" && model !== "User") return { id: "other", ...data };
          return client.insertUser(data);
        },
        delete: async (args: { model: string; where: unknown }) =>
          client.deleteUser?.(args) ?? { id: "deleted" },
        deleteMany: async (args: { model: string; where: unknown }) =>
          client.deleteManyRows?.(args) ?? { count: 0 },
        update: async (args: { model: string; where: unknown; update: unknown }) =>
          client.updateRow?.(args) ?? {},
        transaction: async (callback: (trx: unknown) => Promise<unknown>) => callback(adapter),
      };
      return adapter;
    },
}));

const MATCH = "owner@example.com";
const OTHER = "other@example.com";

const prodConfigured: BootstrapPolicy = {
  nodeEnv: "production",
  adminEmail: MATCH,
  signupEnabled: false,
};
const prodUnconfigured: BootstrapPolicy = {
  nodeEnv: "production",
  adminEmail: undefined,
  signupEnabled: false,
};
const devUnconfigured: BootstrapPolicy = {
  nodeEnv: "development",
  adminEmail: undefined,
  signupEnabled: false,
};
const devConfigured: BootstrapPolicy = {
  nodeEnv: "development",
  adminEmail: MATCH,
  signupEnabled: false,
};

function decide(overrides: {
  bootstrapComplete: boolean;
  policy: BootstrapPolicy;
  email?: string;
  creationMode?: "admin-bootstrap" | "admin-invite";
  requestedRole?: unknown;
  signupEnabled?: boolean;
}) {
  const signupEnabled = overrides.signupEnabled ?? overrides.policy.signupEnabled;
  return decideUserCreate({
    bootstrapComplete: overrides.bootstrapComplete,
    policy: { ...overrides.policy, signupEnabled },
    creationMode: overrides.creationMode,
    email: overrides.email,
    requestedRole: overrides.requestedRole,
  });
}

describe("canonicalizeEmail / role helpers", () => {
  it("trims and lowercases emails", () => {
    expect(canonicalizeEmail("  Owner@Example.COM  ")).toBe(MATCH);
    expect(canonicalizeEmail("")).toBeUndefined();
    expect(canonicalizeEmail(1)).toBeUndefined();
  });

  it("preserves invite roles and defaults empty values", () => {
    expect(preserveRequestedRole("admin")).toBe("admin");
    expect(preserveRequestedRole(["admin", "user"])).toBe("admin,user");
    expect(preserveRequestedRole("")).toBe(DEFAULT_ROLE);
    expect(preserveRequestedRole(undefined)).toBe(DEFAULT_ROLE);
  });

  it("recognizes Better Auth user model names", () => {
    expect(isUserModel("user")).toBe(true);
    expect(isUserModel("session")).toBe(false);
  });
});

describe("decideUserCreate matrix", () => {
  const envs = [
    { name: "production", configured: prodConfigured, unconfigured: prodUnconfigured },
    { name: "development", configured: devConfigured, unconfigured: devUnconfigured },
    {
      name: "test",
      configured: { ...devConfigured, nodeEnv: "test" },
      unconfigured: { ...devUnconfigured, nodeEnv: "test" },
    },
  ] as const;

  for (const node of envs) {
    for (const configured of [true, false]) {
      for (const signupEnabled of [true, false]) {
        for (const bootstrapComplete of [true, false]) {
          const policy = configured ? node.configured : node.unconfigured;
          const production = node.name === "production";
          const label = `${configured ? "configured" : "unconfigured"} × ${node.name} × signup ${signupEnabled ? "on" : "off"} × bootstrap ${bootstrapComplete ? "complete" : "incomplete"}`;

          it(`${label}: matching identity`, () => {
            const result = decide({
              bootstrapComplete,
              policy,
              email: MATCH,
              signupEnabled,
            });
            if (bootstrapComplete) {
              if (!signupEnabled) {
                expect(result).toEqual({ action: "reject", message: SIGNUP_DISABLED_MESSAGE });
              } else {
                expect(result).toEqual({
                  action: "create",
                  role: DEFAULT_ROLE,
                  completeBootstrap: false,
                });
              }
              return;
            }
            if (production && !configured) {
              expect(result).toEqual({ action: "reject", message: SIGNUP_DISABLED_MESSAGE });
              return;
            }
            if (production && configured) {
              expect(result).toEqual({
                action: "create",
                role: FIRST_USER_ROLE,
                canonicalEmail: MATCH,
                completeBootstrap: true,
              });
              return;
            }
            expect(result.action).toBe("create");
            if (result.action === "create") {
              expect(result.role).toBe(FIRST_USER_ROLE);
              expect(result.completeBootstrap).toBe(true);
            }
          });

          it(`${label}: other identity`, () => {
            const result = decide({
              bootstrapComplete,
              policy,
              email: OTHER,
              signupEnabled,
            });
            if (bootstrapComplete) {
              if (!signupEnabled) {
                expect(result).toEqual({ action: "reject", message: SIGNUP_DISABLED_MESSAGE });
              } else {
                expect(result).toEqual({
                  action: "create",
                  role: DEFAULT_ROLE,
                  completeBootstrap: false,
                });
              }
              return;
            }
            if (production) {
              expect(result).toEqual({ action: "reject", message: SIGNUP_DISABLED_MESSAGE });
              return;
            }
            expect(result).toEqual({
              action: "create",
              role: FIRST_USER_ROLE,
              completeBootstrap: true,
            });
          });
        }
      }
    }
  }

  it("configured identity after demotion never gains admin", () => {
    for (const policy of [prodConfigured, devConfigured, { ...devConfigured, nodeEnv: "test" }]) {
      for (const signupEnabled of [true, false]) {
        const result = decide({
          bootstrapComplete: true,
          policy,
          email: MATCH,
          signupEnabled,
        });
        if (!signupEnabled) {
          expect(result.action).toBe("reject");
        } else if (result.action === "create") {
          expect(result.role).toBe(DEFAULT_ROLE);
          expect(result.completeBootstrap).toBe(false);
        }
      }
    }
  });

  it("admin invite is allowed when signup is disabled after bootstrap", () => {
    const result = decide({
      bootstrapComplete: true,
      policy: prodConfigured,
      email: OTHER,
      creationMode: "admin-invite",
      requestedRole: "user",
      signupEnabled: false,
    });
    expect(result).toEqual({
      action: "create",
      role: "user",
      completeBootstrap: false,
    });
  });

  it("production requires the configured identity even when signup is enabled", () => {
    const result = decide({
      bootstrapComplete: false,
      policy: prodConfigured,
      email: OTHER,
      signupEnabled: true,
    });
    expect(result).toEqual({ action: "reject", message: SIGNUP_DISABLED_MESSAGE });
  });
});

describe("isAdminBootstrapSignupEnabled", () => {
  it("shows the signup form only while bootstrap is open and identity is admissible", () => {
    expect(
      isAdminBootstrapSignupEnabled({
        signupEnabled: false,
        bootstrapComplete: false,
        nodeEnv: "production",
        adminEmail: MATCH,
      }),
    ).toBe(true);
    expect(
      isAdminBootstrapSignupEnabled({
        signupEnabled: false,
        bootstrapComplete: false,
        nodeEnv: "production",
        adminEmail: undefined,
      }),
    ).toBe(false);
    expect(
      isAdminBootstrapSignupEnabled({
        signupEnabled: false,
        bootstrapComplete: false,
        nodeEnv: "development",
        adminEmail: undefined,
      }),
    ).toBe(true);
    expect(
      isAdminBootstrapSignupEnabled({
        signupEnabled: true,
        bootstrapComplete: false,
        nodeEnv: "production",
        adminEmail: MATCH,
      }),
    ).toBe(false);
    expect(
      isAdminBootstrapSignupEnabled({
        signupEnabled: false,
        bootstrapComplete: true,
        nodeEnv: "development",
        adminEmail: MATCH,
      }),
    ).toBe(false);
  });
});

type MemoryUser = { id: string; email?: unknown; role?: unknown };

function createMemoryBootstrapFixture(options?: {
  failNextInsert?: boolean;
  users?: MemoryUser[];
  completedAt?: Date | null;
  userId?: string | null;
  policy?: BootstrapPolicy;
}) {
  let state = {
    completedAt: options?.completedAt ?? null,
    userId: options?.userId ?? null,
  };
  const users: MemoryUser[] = [...(options?.users ?? [])];
  let chain = Promise.resolve();
  let failNextInsert = options?.failNextInsert ?? false;
  const policy = options?.policy ?? {
    nodeEnv: "development",
    adminEmail: undefined,
    signupEnabled: true,
  };

  const runTransaction = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = async () => {
      const snapshot = {
        state: { ...state },
        users: users.map((user) => ({ ...user })),
      };
      try {
        return await fn();
      } catch (error) {
        state = snapshot.state;
        users.splice(0, users.length, ...snapshot.users);
        throw error;
      }
    };
    const next = chain.then(run, run);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    users,
    state: () => state,
    setFailNextInsert(value: boolean) {
      failNextInsert = value;
    },
    create: (data: Record<string, unknown>) =>
      runTransaction(async () =>
        runBootstrappedUserCreate({
          data,
          createUser: async (payload) => {
            if (failNextInsert) {
              failNextInsert = false;
              throw new Error("insert failed");
            }
            const user: MemoryUser = {
              id: `user_${users.length + 1}`,
              email: payload.email,
              role: payload.role,
            };
            users.push(user);
            return user;
          },
          lockState: async () => ({ completedAt: state.completedAt }),
          adoptExistingUsers: async () => {
            if (users.length === 0) return null;
            const configured = policy.adminEmail
              ? users.find((user) => canonicalizeEmail(user.email) === policy.adminEmail)
              : undefined;
            const at = new Date();
            state = { completedAt: at, userId: configured?.id ?? null };
            return { completedAt: at };
          },
          complete: async (userId, at) => {
            state = { completedAt: at, userId };
          },
          policy,
          creationMode: undefined,
        }),
      ),
  };
}

describe("runBootstrappedUserCreate transactional fixture", () => {
  it("runs two concurrent first-user creates: exactly one admin and one completed singleton", async () => {
    const fixture = createMemoryBootstrapFixture();
    const [first, second] = await Promise.all([
      fixture.create({ email: "a@example.com", name: "A" }),
      fixture.create({ email: "b@example.com", name: "B" }),
    ]);

    const created = [first, second];
    expect(created).toHaveLength(2);
    expect(fixture.users).toHaveLength(2);
    expect(fixture.users.filter((user) => user.role === FIRST_USER_ROLE)).toHaveLength(1);
    expect(fixture.users.filter((user) => user.role === DEFAULT_ROLE)).toHaveLength(1);
    expect(fixture.state().completedAt).toBeInstanceOf(Date);
    expect(fixture.state().userId).toBe(
      fixture.users.find((user) => user.role === FIRST_USER_ROLE)?.id,
    );
  });

  it("rolls the singleton back when the user insert fails", async () => {
    const fixture = createMemoryBootstrapFixture({ failNextInsert: true });
    await expect(fixture.create({ email: "a@example.com" })).rejects.toThrow("insert failed");
    expect(fixture.users).toHaveLength(0);
    expect(fixture.state()).toEqual({ completedAt: null, userId: null });

    const created = await fixture.create({ email: "a@example.com" });
    expect(created.role).toBe(FIRST_USER_ROLE);
    expect(fixture.state().completedAt).toBeInstanceOf(Date);
    expect(fixture.state().userId).toBe(created.id);
  });

  it("does not reopen bootstrap after the chosen user is deleted", async () => {
    const fixture = createMemoryBootstrapFixture({
      completedAt: new Date("2026-01-01T00:00:00Z"),
      userId: null,
    });
    const created = await fixture.create({ email: MATCH });
    expect(created.role).toBe(DEFAULT_ROLE);
    expect(fixture.state().completedAt).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(fixture.state().userId).toBeNull();
  });

  it("adopts existing users instead of promoting a second admin", async () => {
    const fixture = createMemoryBootstrapFixture({
      users: [{ id: "existing", email: MATCH, role: FIRST_USER_ROLE }],
      policy: { nodeEnv: "development", adminEmail: MATCH, signupEnabled: true },
    });
    const created = await fixture.create({ email: OTHER });
    expect(created.role).toBe(DEFAULT_ROLE);
    expect(fixture.users.filter((user) => user.role === FIRST_USER_ROLE)).toHaveLength(1);
    expect(fixture.state().completedAt).toBeInstanceOf(Date);
    expect(fixture.state().userId).toBe("existing");

    const later = await fixture.create({ email: "third@example.com" });
    expect(later.role).toBe(DEFAULT_ROLE);
    expect(fixture.users.filter((user) => user.role === FIRST_USER_ROLE)).toHaveLength(1);
  });
});

describe("isBootstrapComplete", () => {
  it("is false when the singleton is empty and no users exist", async () => {
    expect(
      await isBootstrapComplete({
        $transaction: async (fn) => fn({} as never),
        bootstrapState: { findUnique: async () => null },
        user: { findFirst: async () => null },
      }),
    ).toBe(false);
  });

  it("is true when completedAt is set", async () => {
    expect(
      await isBootstrapComplete({
        $transaction: async (fn) => fn({} as never),
        bootstrapState: { findUnique: async () => ({ completedAt: new Date("2026-01-01") }) },
        user: { findFirst: async () => null },
      }),
    ).toBe(true);
  });

  it("is true when users exist even if the singleton is empty", async () => {
    expect(
      await isBootstrapComplete({
        $transaction: async (fn) => fn({} as never),
        bootstrapState: { findUnique: async () => ({ completedAt: null }) },
        user: { findFirst: async () => ({ id: "existing" }) },
      }),
    ).toBe(true);
  });
});

describe("adoptExistingUsers", () => {
  it("stamps the configured identity when that user already exists", async () => {
    const users = [
      { id: "other", email: OTHER },
      { id: "owner", email: MATCH },
    ];
    let updated: { completedAt: Date; userId: string | null } | undefined;
    const snapshot = await adoptExistingUsers(
      {
        $queryRaw: async () => [],
        $executeRaw: async () => 0,
        bootstrapState: {
          upsert: async () => ({}),
          findUnique: async () => ({ completedAt: null }),
          update: async ({ data }) => {
            updated = data;
            return {};
          },
        },
        user: {
          findFirst: async ({ where }) => {
            const found = where?.email
              ? users.find((user) => user.email === where.email)
              : users[0];
            return found ? { id: found.id } : null;
          },
        },
      },
      prodConfigured,
    );
    expect(snapshot?.completedAt).toBeInstanceOf(Date);
    expect(updated?.userId).toBe("owner");
  });

  it("returns null when the user table is empty", async () => {
    const snapshot = await adoptExistingUsers(
      {
        $queryRaw: async () => [],
        $executeRaw: async () => 0,
        bootstrapState: {
          upsert: async () => ({}),
          findUnique: async () => ({ completedAt: null }),
          update: async () => ({}),
        },
        user: { findFirst: async () => null },
      },
      prodConfigured,
    );
    expect(snapshot).toBeNull();
  });
});

type FakeUser = { id: string; email?: unknown; role?: unknown };

function createFakePrisma(options?: {
  users?: FakeUser[];
  completedAt?: Date | null;
  userId?: string | null;
}) {
  let state = {
    completedAt: options?.completedAt ?? null,
    userId: options?.userId ?? null,
  };
  const users: FakeUser[] = [...(options?.users ?? [])];
  let nextId = users.length + 1;

  const tx = {
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    bootstrapState: {
      upsert: async () => ({}),
      findUnique: async () => ({ completedAt: state.completedAt }),
      update: async ({ data }: { data: { completedAt: Date; userId: string | null } }) => {
        state = { completedAt: data.completedAt, userId: data.userId };
        return {};
      },
    },
    user: {
      findFirst: async ({ where }: { where?: { email: string }; select: { id: true } }) => {
        const found = where?.email ? users.find((user) => user.email === where.email) : users[0];
        return found ? { id: found.id } : null;
      },
    },
    insertUser: async (data: Record<string, unknown>) => {
      const user: FakeUser = {
        id: `user_${nextId++}`,
        email: data.email,
        role: data.role,
      };
      users.push(user);
      return user;
    },
  };

  let chain = Promise.resolve();
  const runTransaction = <T>(fn: (client: typeof tx) => Promise<T>): Promise<T> => {
    const run = async () => {
      const snapshot = {
        state: { ...state },
        users: users.map((user) => ({ ...user })),
        nextId,
      };
      try {
        return await fn(tx);
      } catch (error) {
        state = snapshot.state;
        users.splice(0, users.length, ...snapshot.users);
        nextId = snapshot.nextId;
        throw error;
      }
    };
    const next = chain.then(run, run);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    ...tx,
    users,
    state: () => state,
    insertUser: tx.insertUser,
    $transaction: runTransaction,
  };
}

describe("createBootstrapDatabaseAdapter", () => {
  afterEach(() => {
    envState.NODE_ENV = "test";
    envState.ADMIN_EMAIL = undefined;
    envState.SIGNUP_ENABLED = false;
  });

  it("returns a Better Auth adapter factory", () => {
    const factory = createBootstrapDatabaseAdapter({
      $transaction: async (fn) => fn({} as never),
      $queryRaw: async () => [],
      $executeRaw: async () => 0,
      bootstrapState: {
        findUnique: async () => null,
        upsert: async () => ({}),
        update: async () => ({}),
      },
      user: { findFirst: async () => null },
    });
    expect(typeof factory).toBe("function");
    expect(BOOTSTRAP_STATE_ID).toBe("singleton");
  });

  it("applies decideUserCreate when create runs inside adapter.transaction", async () => {
    envState.SIGNUP_ENABLED = true;
    const prisma = createFakePrisma();
    const adapter = createBootstrapDatabaseAdapter(prisma)({} as never);
    const created = await adapter.transaction((trx) =>
      trx.create({ model: "user", data: { email: MATCH, name: "Owner" } }),
    );
    expect(created).toMatchObject({ email: MATCH, role: FIRST_USER_ROLE });
    expect(prisma.state().completedAt).toBeInstanceOf(Date);
    expect(prisma.users.filter((user) => user.role === FIRST_USER_ROLE)).toHaveLength(1);
  });

  it("rejects a production non-matching first signup on the transaction path", async () => {
    envState.NODE_ENV = "production";
    envState.ADMIN_EMAIL = MATCH;
    envState.SIGNUP_ENABLED = true;
    const prisma = createFakePrisma();
    const adapter = createBootstrapDatabaseAdapter(prisma)({} as never);
    await expect(
      adapter.transaction((trx) => trx.create({ model: "user", data: { email: OTHER } })),
    ).rejects.toThrow(SIGNUP_DISABLED_MESSAGE);
    expect(prisma.users).toHaveLength(0);
    expect(prisma.state().completedAt).toBeNull();
  });

  it("promotes the configured production identity on the transaction path", async () => {
    envState.NODE_ENV = "production";
    envState.ADMIN_EMAIL = MATCH;
    envState.SIGNUP_ENABLED = true;
    const prisma = createFakePrisma();
    const adapter = createBootstrapDatabaseAdapter(prisma)({} as never);
    const created = await adapter.transaction((trx) =>
      trx.create({ model: "user", data: { email: "  Owner@Example.COM  " } }),
    );
    expect(created).toMatchObject({ email: MATCH, role: FIRST_USER_ROLE });
    expect(prisma.state().userId).toBe((created as { id: string }).id);
  });

  it("rejects public create after completion when signup is disabled, including via transaction", async () => {
    envState.SIGNUP_ENABLED = false;
    const prisma = createFakePrisma({
      completedAt: new Date("2026-01-01T00:00:00Z"),
      userId: "existing",
      users: [{ id: "existing", email: MATCH, role: FIRST_USER_ROLE }],
    });
    const adapter = createBootstrapDatabaseAdapter(prisma)({} as never);
    await expect(
      adapter.transaction((trx) => trx.create({ model: "user", data: { email: OTHER } })),
    ).rejects.toThrow(SIGNUP_DISABLED_MESSAGE);
    expect(prisma.users).toHaveLength(1);
  });

  it("stamps an empty singleton when users already exist and does not promote a second admin", async () => {
    envState.SIGNUP_ENABLED = true;
    envState.ADMIN_EMAIL = MATCH;
    const prisma = createFakePrisma({
      users: [{ id: "existing", email: MATCH, role: FIRST_USER_ROLE }],
    });
    const adapter = createBootstrapDatabaseAdapter(prisma)({} as never);
    const created = await adapter.create({ model: "user", data: { email: OTHER } });
    expect(created).toMatchObject({ email: OTHER, role: DEFAULT_ROLE });
    expect(prisma.state().completedAt).toBeInstanceOf(Date);
    expect(prisma.state().userId).toBe("existing");
    expect(prisma.users.filter((user) => user.role === FIRST_USER_ROLE)).toHaveLength(1);

    const later = await adapter.create({ model: "user", data: { email: "third@example.com" } });
    expect(later).toMatchObject({ role: DEFAULT_ROLE });
  });

  it("keeps the singleton completed when a post-adoption public create is rejected", async () => {
    envState.SIGNUP_ENABLED = false;
    envState.ADMIN_EMAIL = MATCH;
    const prisma = createFakePrisma({
      users: [{ id: "existing", email: MATCH, role: FIRST_USER_ROLE }],
    });
    const adapter = createBootstrapDatabaseAdapter(prisma)({} as never);
    await expect(adapter.create({ model: "user", data: { email: OTHER } })).rejects.toThrow(
      SIGNUP_DISABLED_MESSAGE,
    );
    expect(prisma.users).toHaveLength(1);
    expect(prisma.state().completedAt).toBeInstanceOf(Date);
    expect(prisma.state().userId).toBe("existing");
  });

  it("keeps the singleton completed when a post-adoption create inside transaction is rejected", async () => {
    envState.SIGNUP_ENABLED = false;
    envState.ADMIN_EMAIL = MATCH;
    const prisma = createFakePrisma({
      users: [{ id: "existing", email: MATCH, role: FIRST_USER_ROLE }],
    });
    const adapter = createBootstrapDatabaseAdapter(prisma)({} as never);
    await expect(
      adapter.transaction((trx) => trx.create({ model: "user", data: { email: OTHER } })),
    ).rejects.toThrow(SIGNUP_DISABLED_MESSAGE);
    expect(prisma.users).toHaveLength(1);
    expect(prisma.state().completedAt).toBeInstanceOf(Date);
    expect(prisma.state().userId).toBe("existing");
  });
});

describe("persistBootstrapAdoption", () => {
  it("is a no-op when no users exist", async () => {
    const prisma = createFakePrisma();
    await persistBootstrapAdoption(prisma);
    expect(prisma.state()).toEqual({ completedAt: null, userId: null });
  });
});

function createRemovalGuardPrisma(options?: { ownedActiveKbs?: number }) {
  const deleteManyCalls: Array<{ model: string; where: unknown }> = [];
  const client = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
    $queryRaw: async () => [],
    $executeRaw: async () => 0,
    bootstrapState: {
      upsert: async () => ({}),
      findUnique: async () => ({ completedAt: new Date() }),
      update: async () => ({}),
    },
    user: { findFirst: async () => null },
    knowledgeBase: {
      count: async () => options?.ownedActiveKbs ?? 0,
    },
    deleteManyRows: async (args: { model: string; where: unknown }) => {
      deleteManyCalls.push(args);
      return { count: 1 };
    },
  };
  return { client, deleteManyCalls };
}

describe("account-removal adapter guard", () => {
  it("blocks the account cascade before credential rows die when the user owns ACTIVE KBs", async () => {
    const { client, deleteManyCalls } = createRemovalGuardPrisma({ ownedActiveKbs: 1 });
    const adapter = createBootstrapDatabaseAdapter(client as never)({} as never);
    await expect(
      adapter.deleteMany({
        model: "account",
        where: [{ field: "userId", value: "u1" }],
      }),
    ).rejects.toThrow(OWNED_ACTIVE_KB_BLOCK_MESSAGE);
    expect(deleteManyCalls).toHaveLength(0);
  });

  it("passes the account cascade through when ordinary deletion is allowed", async () => {
    const { client, deleteManyCalls } = createRemovalGuardPrisma({ ownedActiveKbs: 0 });
    const adapter = createBootstrapDatabaseAdapter(client as never)({} as never);
    await expect(
      adapter.deleteMany({
        model: "account",
        where: [{ field: "userId", value: "u1" }],
      }),
    ).resolves.toEqual({ count: 1 });
    expect(deleteManyCalls).toHaveLength(1);
  });

  it("never consults the policy for session-scoped deletions (legitimate revocations)", async () => {
    const { client, deleteManyCalls } = createRemovalGuardPrisma();
    client.knowledgeBase.count = async () => {
      throw new Error("session revocation must not consult the KB ownership policy");
    };
    const adapter = createBootstrapDatabaseAdapter(client as never)({} as never);
    await expect(
      adapter.deleteMany({
        model: "session",
        where: [{ field: "userId", value: "u1" }],
      }),
    ).resolves.toEqual({ count: 1 });
    expect(deleteManyCalls).toHaveLength(1);
  });

  it("guards inside adapter.transaction as well", async () => {
    const { client, deleteManyCalls } = createRemovalGuardPrisma({ ownedActiveKbs: 2 });
    const adapter = createBootstrapDatabaseAdapter(client as never)({} as never);
    await expect(
      adapter.transaction((trx) =>
        trx.deleteMany({
          model: "account",
          where: [{ field: "userId", value: "u1" }],
        }),
      ),
    ).rejects.toThrow(OWNED_ACTIVE_KB_BLOCK_MESSAGE);
    expect(deleteManyCalls).toHaveLength(0);
  });
});

describe("ban writes through the Better Auth adapter", () => {
  function banPrisma() {
    const steps: string[] = [];
    const client = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        steps.push("begin");
        const result = await fn(client);
        steps.push("commit");
        return result;
      },
      $queryRaw: async () => [],
      $executeRaw: async (strings: TemplateStringsArray) => {
        if (strings.join("").includes("pg_advisory_xact_lock")) steps.push("authority-lock");
        return 0;
      },
      $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
        if (
          sql.startsWith("CREATE TEMP") ||
          sql.startsWith("INSERT INTO pg_temp") ||
          sql.startsWith("WITH outgoing")
        )
          return 0;
        if (sql.includes('SET "twoFactorGraceStartedAt" = u."createdAt"')) {
          steps.push(`grace-materialize:${String(params.at(-1))}`);
          return 0;
        }
        steps.push(
          `${sql.startsWith("WITH revoked") ? "lapse" : sql.match(/UPDATE "(\w+)"/)?.[1]}:${String(params[0])}`,
        );
        return 1;
      },
      bootstrapState: {
        upsert: async () => ({}),
        findUnique: async () => ({ completedAt: new Date() }),
        update: async () => ({}),
      },
      user: { findFirst: async () => null },
      knowledgeBase: { count: async () => 0 },
      updateRow: async (args: { update: unknown }) => {
        steps.push(`user-update:${JSON.stringify(args.update)}`);
        return { id: "u1" };
      },
    };
    return { client, steps };
  }

  function administrativeFixture() {
    const { client, steps } = banPrisma();
    const actor = {
      role: "admin",
      emailVerified: true,
      banned: false,
      banExpires: null as Date | null,
      twoFactorEnabled: true,
      createdAt: new Date("2025-01-01"),
      twoFactorGraceStartedAt: null as Date | null,
      forcedTwoFactorValue: null as string | null,
    };
    const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("").includes('FROM "user"')) {
        steps.push(`actor:${String(values[0])}`);
        return [{ ...actor }];
      }
      return [];
    });
    const write = vi.fn(async () => ({ id: "target" }));
    const target = {
      ...client,
      $queryRaw: query,
      updateRow: write,
      deleteUser: write,
      deleteManyRows: write,
      insertUser: write,
    };
    let committed = 0;
    const transaction = vi.fn(async (fn: (tx: typeof target) => Promise<unknown>) => {
      const result = await fn(target);
      committed++;
      return result;
    });
    const adapter = createBootstrapDatabaseAdapter({
      ...target,
      $transaction: transaction,
    } as never)({} as never);
    return { actor, steps, query, write, adapter, committed: () => committed };
  }

  const adminMutations = [
    [
      "set-role",
      (adapter: ReturnType<typeof administrativeFixture>["adapter"]) =>
        adapter.update({
          model: "user",
          where: [{ field: "id", value: "target" }],
          update: { role: "admin" },
        }),
    ],
    [
      "ban-user",
      (adapter: ReturnType<typeof administrativeFixture>["adapter"]) =>
        adapter.update({
          model: "user",
          where: [{ field: "id", value: "target" }],
          update: { banned: true, banExpires: new Date(Date.now() + 1000) },
        }),
    ],
    [
      "unban-user",
      (adapter: ReturnType<typeof administrativeFixture>["adapter"]) =>
        adapter.update({
          model: "user",
          where: [{ field: "id", value: "target" }],
          update: { banned: false },
        }),
    ],
    [
      "revoke-session",
      (adapter: ReturnType<typeof administrativeFixture>["adapter"]) =>
        adapter.delete({ model: "session", where: [{ field: "token", value: "target-session" }] }),
    ],
    [
      "revoke-user-sessions",
      (adapter: ReturnType<typeof administrativeFixture>["adapter"]) =>
        adapter.deleteMany({ model: "session", where: [{ field: "userId", value: "target" }] }),
    ],
    [
      "invite-admin",
      (adapter: ReturnType<typeof administrativeFixture>["adapter"]) =>
        runWithAllowedUserCreation("admin-invite", () =>
          adapter.create({ model: "user", data: { email: OTHER, role: "admin" } }),
        ),
    ],
  ] as const;

  it.each(adminMutations)(
    "%s rejects an admitted actor demoted while waiting for authority",
    async (_name, mutate) => {
      const fixture = administrativeFixture();
      fixture.actor.role = "user";
      await expect(
        runWithAdminMutationActor("acting-admin", () => mutate(fixture.adapter)),
      ).rejects.toMatchObject({ status: "FORBIDDEN" });
      expect(fixture.write).not.toHaveBeenCalled();
      expect(fixture.steps.indexOf("authority-lock")).toBeLessThan(
        fixture.steps.indexOf("actor:acting-admin"),
      );
    },
  );

  it.each([
    { banned: true },
    { emailVerified: false },
    { twoFactorEnabled: false },
    { banned: true, banExpires: new Date(Date.now() + 60_000) },
  ])("rejects a live actor who no longer meets admin policy: %j", async (change) => {
    const fixture = administrativeFixture();
    Object.assign(fixture.actor, change);
    await expect(
      runWithAdminMutationActor("acting-admin", () => adminMutations[0][1](fixture.adapter)),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it.each(adminMutations)(
    "%s preserves admitted live admin writes in the same transaction",
    async (_name, mutate) => {
      const fixture = administrativeFixture();
      await runWithAdminMutationActor("acting-admin", () => mutate(fixture.adapter));
      expect(fixture.write).toHaveBeenCalledOnce();
      expect(fixture.query).toHaveBeenCalledWith(expect.any(Array), "acting-admin");
      expect(fixture.committed()).toBeGreaterThan(0);
    },
  );

  it("keeps explicitly disabled forced 2FA effective for live admins", async () => {
    const fixture = administrativeFixture();
    fixture.actor.twoFactorEnabled = false;
    fixture.actor.forcedTwoFactorValue = "false";
    await runWithAdminMutationActor("acting-admin", () => adminMutations[0][1](fixture.adapter));
    expect(fixture.write).toHaveBeenCalledOnce();
  });

  it("refuses a deleted acting administrator", async () => {
    const fixture = administrativeFixture();
    fixture.query.mockResolvedValue([]);
    await expect(
      runWithAdminMutationActor("acting-admin", () => adminMutations[0][1](fixture.adapter)),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it("keeps expired temporary bans non-blocking", async () => {
    const fixture = administrativeFixture();
    fixture.actor.banned = true;
    fixture.actor.banExpires = new Date(Date.now() - 1000);
    await runWithAdminMutationActor("acting-admin", () => adminMutations[0][1](fixture.adapter));
    expect(fixture.write).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "rechecks grace before commit, including transactional callback waits (%s)",
    async (nested) => {
      const fixture = administrativeFixture();
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      fixture.actor.twoFactorEnabled = false;
      fixture.actor.twoFactorGraceStartedAt = new Date(now - 86_400_000 + 1);
      if (!nested)
        fixture.write.mockImplementation(async () => {
          clock.mockReturnValue(now + 2);
          return { id: "target" };
        });
      try {
        await expect(
          runWithAdminMutationActor("acting-admin", () =>
            nested
              ? fixture.adapter.transaction(async (tx) => {
                  await tx.delete({ model: "session", where: [] });
                  clock.mockReturnValue(now + 2);
                })
              : adminMutations[0][1](fixture.adapter),
          ),
        ).rejects.toMatchObject({ status: "FORBIDDEN" });
        // Nested mode commits only the pre-existing bootstrap adoption transaction.
        expect(fixture.committed()).toBe(nested ? 1 : 0);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("requires a bound acting administrator for admin-invite creation", async () => {
    const fixture = administrativeFixture();
    await expect(
      runWithAllowedUserCreation("admin-invite", () =>
        fixture.adapter.create({ model: "user", data: { email: OTHER, role: "admin" } }),
      ),
    ).rejects.toMatchObject({ status: "FORBIDDEN" });
    expect(fixture.write).not.toHaveBeenCalled();
  });

  it("tombstones the user's MCP grants inside the same authority-locked transaction", async () => {
    const { client, steps } = banPrisma();
    const adapter = createBootstrapDatabaseAdapter(client as never)({} as never);
    await adapter.update({
      model: "user",
      where: [{ field: "id", value: "u1" }],
      update: { banned: true, banReason: null },
    });
    expect(steps).toEqual([
      "begin",
      "authority-lock",
      // A covered user's NULL grace start is written down before any write.
      "grace-materialize:u1",
      "lapse:u1",
      'user-update:{"banned":true,"banReason":null}',
      "lapse:u1",
      "mcp_personal_token:u1",
      "mcp_grant:u1",
      "commit",
    ]);
  });

  it("a temporary (dated) ban suspends grants instead of tombstoning them", async () => {
    const { client, steps } = banPrisma();
    const adapter = createBootstrapDatabaseAdapter(client as never)({} as never);
    await adapter.update({
      model: "user",
      where: [{ field: "id", value: "u1" }],
      update: { banned: true, banReason: null, banExpires: new Date(Date.now() + 60_000) },
    });
    expect(steps.filter((step) => step.startsWith("mcp_"))).toEqual([]);
    expect(steps).toContain("authority-lock");
  });

  it("does not touch grants for unban or unrelated user updates", async () => {
    const { client, steps } = banPrisma();
    const adapter = createBootstrapDatabaseAdapter(client as never)({} as never);
    await adapter.update({
      model: "user",
      where: [{ field: "id", value: "u1" }],
      update: { banned: false },
    });
    await adapter.update({
      model: "user",
      where: [{ field: "id", value: "u1" }],
      update: { name: "n" },
    });
    expect(steps.filter((step) => step.startsWith("mcp_"))).toEqual([]);
  });
});

describe("lockBootstrapState", () => {
  it("inserts the singleton then takes FOR UPDATE before reading completion", async () => {
    const calls: string[] = [];
    const tx = {
      $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(`insert:${String.raw({ raw: strings }, ...values)}`);
        return 0;
      },
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(`lock:${String.raw({ raw: strings }, ...values)}`);
        return [];
      },
      bootstrapState: {
        upsert: async () => {
          calls.push("upsert");
          return { id: BOOTSTRAP_STATE_ID };
        },
        findUnique: async () => {
          calls.push("read");
          return { completedAt: null };
        },
        update: async () => ({}) as never,
      },
      user: { findFirst: async () => null },
    };
    const snapshot = await lockBootstrapState(tx);
    expect(snapshot).toEqual({ completedAt: null });
    expect(calls[0]?.startsWith("insert:")).toBe(true);
    expect(calls[0]).toContain("ON CONFLICT");
    expect(calls[1]?.startsWith("lock:")).toBe(true);
    expect(calls[1]).toContain("FOR UPDATE");
    expect(calls[2]).toBe("read");
  });
});
