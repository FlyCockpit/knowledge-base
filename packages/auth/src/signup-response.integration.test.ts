import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type KbPostgresDatabase,
  openKbPostgresClusterFromEnv,
} from "../../test-utils/src/kb/index.js";

// The real `auth` instance (index.ts: real Better Auth handler, admin plugin,
// bootstrap adapter, hooks) on a disposable Postgres. Only env, mail and the
// Prisma client handle are swapped in.
const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));
const envState = vi.hoisted(() => ({
  NODE_ENV: "test",
  ADMIN_EMAIL: undefined as string | undefined,
  SIGNUP_ENABLED: true,
}));
const db = vi.hoisted(() => ({ client: undefined as object | undefined, ops: [] as string[] }));

vi.mock("@knowledge-base/env/server", () => ({
  env: {
    get NODE_ENV() {
      return envState.NODE_ENV;
    },
    BETTER_AUTH_URL: "https://api.example.test",
    BETTER_AUTH_SECRET: new Secret("signup-response-fixture-secret-signup-response"),
    CORS_ORIGIN: undefined,
  },
  get ADMIN_EMAIL() {
    return envState.ADMIN_EMAIL;
  },
  get SIGNUP_ENABLED() {
    return envState.SIGNUP_ENABLED;
  },
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
// Forwards to the current fixture client and records every Prisma call
// (`model.method`), including the ones on a transaction's client, so a test
// can prove two outcomes cost the same database work.
vi.mock("@knowledge-base/db", () => {
  const recording = (client: object): object =>
    new Proxy(client, {
      get: (target, prop) => {
        if (prop === "then") return undefined;
        const value: unknown = Reflect.get(target, prop);
        if (typeof value === "function") {
          return (...args: unknown[]) => {
            db.ops.push(String(prop));
            const [first] = args;
            if (prop === "$transaction" && typeof first === "function") {
              args[0] = (tx: object) => first(recording(tx));
            }
            return Reflect.apply(value, target, args);
          };
        }
        if (
          typeof prop === "string" &&
          !prop.startsWith("_") &&
          value &&
          typeof value === "object"
        ) {
          return new Proxy(value, {
            get: (delegate, method) => {
              const fn: unknown = Reflect.get(delegate, method);
              if (typeof fn !== "function") return fn;
              return (...args: unknown[]) => {
                db.ops.push(`${prop}.${String(method)}`);
                return Reflect.apply(fn, delegate, args);
              };
            },
          });
        }
        return value;
      },
    });
  return {
    default: new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === "then") return undefined;
          if (!db.client) throw new Error("no fixture client");
          return Reflect.get(recording(db.client), prop);
        },
      },
    ),
  };
});

const cluster = await openKbPostgresClusterFromEnv();
const databases: KbPostgresDatabase[] = [];
const clients: Array<{ $disconnect: () => Promise<void> }> = [];
// One database per scenario, provisioned before `auth` loads: Better Auth reads
// the Prisma data model when it initializes.
const fixtures: Array<ReturnType<KbPostgresDatabase["createPrismaClient"]>> = [];
for (let i = 0; i < 3; i++) {
  const database = await cluster.createDatabase();
  databases.push(database);
  database.applyPrismaSchema();
  const prisma = database.createPrismaClient("runtime");
  clients.push(prisma);
  fixtures.push(prisma);
}
db.client = fixtures[0];

const { auth } = await import("./index");
const { runWithAllowedUserCreation } = await import("./user-creation-policy");

function useDatabase(index: number) {
  const prisma = fixtures[index];
  if (!prisma) throw new Error(`no fixture ${index}`);
  db.client = prisma;
  return prisma;
}

type Snapshot = { status: number; headers: [string, string][]; body: string };

async function signUp(email: string): Promise<Snapshot> {
  const res = await auth.handler(
    new Request("https://api.example.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://api.example.test" },
      body: JSON.stringify({ name: "Same Name", email, password: "same-password-12345" }),
    }),
  );
  return {
    status: res.status,
    headers: [...res.headers.entries()].filter(([name]) => name !== "date"),
    body: await res.text(),
  };
}

async function withOps<T>(fn: () => Promise<T>) {
  db.ops.length = 0;
  const result = await fn();
  return { result, ops: [...db.ops] };
}

const NEUTRAL = '{"token":null,"user":null}';

beforeAll(() => {
  envState.NODE_ENV = "test";
  envState.ADMIN_EMAIL = undefined;
  envState.SIGNUP_ENABLED = true;
});

afterAll(async () => {
  for (const client of clients) await client.$disconnect();
  for (const database of databases) await database.close();
  await cluster.close();
});

describe("sign-up response is the same for free and registered addresses", () => {
  it("answers new, registered-verified and registered-unverified byte-identically", async () => {
    const prisma = useDatabase(0);
    envState.SIGNUP_ENABLED = true;
    // The first account is the bootstrap admin; the rest are ordinary users.
    expect((await signUp("first@example.test")).body).toBe(NEUTRAL);
    await signUp("taken-verified@example.test");
    await signUp("taken-unverified@example.test");
    await prisma.user.update({
      where: { email: "taken-verified@example.test" },
      data: { emailVerified: true },
    });

    const fresh = await signUp("fresh@example.test");
    expect(fresh.status).toBe(200);
    expect(fresh.body).toBe(NEUTRAL);
    expect(fresh.headers.some(([name]) => name === "set-cookie")).toBe(false);
    expect(await signUp("taken-verified@example.test")).toEqual(fresh);
    expect(await signUp("taken-unverified@example.test")).toEqual(fresh);

    const users = await prisma.user.findMany({
      select: { email: true, role: true },
      orderBy: { email: "asc" },
    });
    expect(users).toEqual([
      { email: "first@example.test", role: "admin" },
      { email: "fresh@example.test", role: "user" },
      { email: "taken-unverified@example.test", role: "user" },
      { email: "taken-verified@example.test", role: "user" },
    ]);

    // Sign-up disabled after bootstrap: every address gets the same 422 with
    // the same database work, admin-marked or not.
    envState.SIGNUP_ENABLED = false;
    envState.ADMIN_EMAIL = "first@example.test";
    try {
      const closed = await withOps(() => signUp("fresh-2@example.test"));
      expect(closed.result.status).toBe(422);
      expect(JSON.parse(closed.result.body)).toMatchObject({ code: "FAILED_TO_CREATE_USER" });
      const taken = await withOps(() => signUp("taken-verified@example.test"));
      expect(taken.result).toEqual(closed.result);
      expect(taken.ops).toEqual(closed.ops);
      expect((await withOps(() => signUp("taken-unverified@example.test"))).ops).toEqual(
        closed.ops,
      );
      // Refused before Better Auth looks the address up or the bootstrap
      // adapter opens its transaction: only the address-independent state read.
      expect(closed.ops).not.toContain("$transaction");
      expect(closed.ops).not.toContain("user.findFirst");
      expect(closed.ops).toContain("bootstrapState.findUnique");
      const asAdminMarked = (email: string) =>
        withOps(() => runWithAllowedUserCreation("admin-bootstrap", () => signUp(email)));
      for (const email of ["first@example.test", "fresh-3@example.test"]) {
        const marked = await asAdminMarked(email);
        expect(marked.result).toEqual(closed.result);
        expect(marked.ops).toEqual(closed.ops);
      }
      expect(await prisma.user.count()).toBe(4);
    } finally {
      envState.SIGNUP_ENABLED = true;
      envState.ADMIN_EMAIL = undefined;
    }
  });

  it("keeps the ADMIN_EMAIL bootstrap with sign-up disabled, then answers it like any address", async () => {
    const prisma = useDatabase(1);
    envState.SIGNUP_ENABLED = false;
    envState.NODE_ENV = "production";
    envState.ADMIN_EMAIL = "owner@example.test";
    try {
      const asMarked = (email: string) =>
        runWithAllowedUserCreation("admin-bootstrap", () => signUp(email));
      // Before bootstrap: an address that is not the operator's is refused.
      const refused = await signUp("stranger@example.test");
      expect(refused.status).toBe(422);
      expect(JSON.parse(refused.body)).toMatchObject({ code: "FAILED_TO_CREATE_USER" });

      const bootstrap = await asMarked("owner@example.test");
      expect(bootstrap.status).toBe(200);
      expect(bootstrap.body).toBe(NEUTRAL);
      expect(await prisma.user.findMany({ select: { email: true, role: true } })).toEqual([
        { email: "owner@example.test", role: "admin" },
      ]);

      // After it: the registered operator address answers exactly like a free one.
      const free = await signUp("stranger@example.test");
      expect(free).toEqual(refused);
      expect(await asMarked("owner@example.test")).toEqual(free);
      expect(await signUp("owner@example.test")).toEqual(free);
      expect(await prisma.user.count()).toBe(1);
    } finally {
      envState.SIGNUP_ENABLED = true;
      envState.NODE_ENV = "test";
      envState.ADMIN_EMAIL = undefined;
    }
  });

  it("keeps the development first-user bootstrap with sign-up disabled", async () => {
    const prisma = useDatabase(2);
    envState.SIGNUP_ENABLED = false;
    try {
      const first = await signUp("dev-first@example.test");
      expect(first.status).toBe(200);
      expect(first.body).toBe(NEUTRAL);
      const again = await signUp("dev-first@example.test");
      expect(again.status).toBe(422);
      expect(await signUp("dev-second@example.test")).toEqual(again);
      expect(await prisma.user.findMany({ select: { email: true, role: true } })).toEqual([
        { email: "dev-first@example.test", role: "admin" },
      ]);
    } finally {
      envState.SIGNUP_ENABLED = true;
    }
  });
});
