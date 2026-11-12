import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type KbPostgresDatabase,
  openKbPostgresClusterFromEnv,
} from "../../test-utils/src/kb/index.js";

import {
  BOOTSTRAP_STATE_ID,
  DEFAULT_ROLE,
  FIRST_USER_ROLE,
  lockBootstrapState,
  runBootstrappedUserCreate,
} from "./bootstrap.js";

const envState = vi.hoisted(() => ({
  NODE_ENV: "test",
  ADMIN_EMAIL: undefined as string | undefined,
  SIGNUP_ENABLED: true,
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

const cluster = await openKbPostgresClusterFromEnv();
let db: KbPostgresDatabase;
let prisma: ReturnType<KbPostgresDatabase["createPrismaClient"]>;

beforeAll(async () => {
  db = await cluster.createDatabase();
  db.applyPrismaSchema();
  prisma = db.createPrismaClient("applier");
});

beforeEach(async () => {
  envState.NODE_ENV = "test";
  envState.ADMIN_EMAIL = undefined;
  envState.SIGNUP_ENABLED = true;
  if (!prisma) return;
  await prisma.user.deleteMany({ where: { email: { endsWith: "@example.com" } } });
  await prisma.bootstrapState.deleteMany({ where: { id: BOOTSTRAP_STATE_ID } });
});

afterEach(() => {
  envState.NODE_ENV = "test";
  envState.ADMIN_EMAIL = undefined;
  envState.SIGNUP_ENABLED = true;
});

afterAll(async () => {
  await prisma?.$disconnect();
  await db?.close();
  await cluster.close();
});

describe("bootstrap against disposable Postgres", () => {
  it("allows exactly one bootstrap admin across two concurrent signups", async () => {
    const signup = (email: string) =>
      prisma.$transaction((tx) =>
        runBootstrappedUserCreate({
          data: { email, name: email },
          createUser: (data) =>
            tx.user.create({
              data: {
                name: String(data.name ?? "User"),
                email: String(data.email),
                emailVerified: false,
                role: String(data.role),
              },
            }),
          lockState: () => lockBootstrapState(tx),
          complete: async (userId, at) => {
            await tx.bootstrapState.update({
              where: { id: BOOTSTRAP_STATE_ID },
              data: { completedAt: at, userId },
            });
          },
          policy: { nodeEnv: "test", adminEmail: undefined, signupEnabled: true },
          creationMode: undefined,
        }),
      );
    const created = await Promise.all([signup("a@example.com"), signup("b@example.com")]);
    expect(created).toHaveLength(2);
    const users = await prisma.user.findMany();
    expect(users).toHaveLength(2);
    expect(users.filter((user) => user.role === FIRST_USER_ROLE)).toHaveLength(1);
    expect(users.filter((user) => user.role === DEFAULT_ROLE)).toHaveLength(1);
    const state = await prisma.bootstrapState.findUnique({ where: { id: BOOTSTRAP_STATE_ID } });
    expect(state?.completedAt).toBeInstanceOf(Date);
    expect(state?.userId).toBe(users.find((user) => user.role === FIRST_USER_ROLE)?.id);
  });

  it("leaves no completed singleton when the first-user transaction aborts", async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await runBootstrappedUserCreate({
          data: { email: "abort@example.com", name: "Abort" },
          createUser: async (data) => {
            await tx.user.create({
              data: {
                name: String(data.name ?? "Abort"),
                email: String(data.email),
                emailVerified: false,
              },
            });
            throw new Error("abort after insert");
          },
          lockState: () => lockBootstrapState(tx),
          complete: async (userId, at) => {
            await tx.bootstrapState.update({
              where: { id: BOOTSTRAP_STATE_ID },
              data: { completedAt: at, userId },
            });
          },
          policy: { nodeEnv: "test", adminEmail: undefined, signupEnabled: true },
          creationMode: undefined,
        });
      }),
    ).rejects.toThrow("abort after insert");
    expect(await prisma.user.count()).toBe(0);
    const state = await prisma.bootstrapState.findUnique({ where: { id: BOOTSTRAP_STATE_ID } });
    expect(state?.completedAt ?? null).toBeNull();
  });
});
