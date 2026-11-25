import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type KbPostgresDatabase,
  openKbPostgresClusterFromEnv,
} from "../../test-utils/src/kb/index.js";

// The real `auth` instance (index.ts) on a disposable Postgres, with a mailer
// stub whose send can see the database, fail or never settle.
const { Secret } = await vi.hoisted(() => import("@knowledge-base/env/secret"));
const db = vi.hoisted(() => ({ client: undefined as object | undefined }));
const mail = vi.hoisted(() => ({
  rendered: [] as Array<{ url: string; locale: string }>,
  sent: [] as Array<{ to: string; userVisible: boolean; locale: string }>,
  mode: "ok" as "ok" | "fail" | "hang",
}));

vi.mock("@knowledge-base/env/server", () => ({
  env: {
    NODE_ENV: "test",
    BETTER_AUTH_URL: "https://api.example.test",
    BETTER_AUTH_SECRET: new Secret("verification-mail-fixture-secret-verification"),
    CORS_ORIGIN: undefined,
  },
  ADMIN_EMAIL: undefined,
  SIGNUP_ENABLED: true,
  SSO_ENABLED: false,
  FORCE_SSO: false,
}));
vi.mock("@knowledge-base/mailer", () => ({
  isEmailConfigured: () => true,
  renderResetPassword: () => ({ subject: "reset", html: "" }),
  renderTwoFactorOtp: () => ({ subject: "otp", html: "" }),
  renderVerifyEmail: (input: { url: string; locale: string }) => {
    mail.rendered.push(input);
    return { subject: `verify:${input.locale}`, html: input.url };
  },
  sendEmail: async (message: { to: string; subject: string }) => {
    if (mail.mode === "hang") return new Promise<void>(() => {});
    if (mail.mode === "fail") throw new Error("connect ETIMEDOUT");
    // A send from inside the user-create transaction would not see the row.
    const prisma = db.client as {
      user: { findUnique: (a: object) => Promise<{ id: string } | null> };
    };
    const row = await prisma.user.findUnique({
      where: { email: message.to },
      select: { id: true },
    });
    mail.sent.push({
      to: message.to,
      userVisible: row != null,
      locale: message.subject.slice("verify:".length),
    });
  },
}));
vi.mock("@knowledge-base/db", () => ({
  default: new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === "then") return undefined;
        if (!db.client) throw new Error("no fixture client");
        return Reflect.get(db.client, prop);
      },
    },
  ),
}));

const cluster = await openKbPostgresClusterFromEnv();
const database: KbPostgresDatabase = await cluster.createDatabase();
database.applyPrismaSchema();
const prisma = database.createPrismaClient("runtime");
db.client = prisma;

const { auth } = await import("./index");
const { captureLog } = await import("@knowledge-base/env/log");

const NEUTRAL = '{"token":null,"user":null}';

async function post(path: string, body: object, locale?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    origin: "https://api.example.test",
  };
  if (locale) headers["x-app-locale"] = locale;
  const started = performance.now();
  const res = await auth.handler(
    new Request(`https://api.example.test/api/auth${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
  return {
    status: res.status,
    headers: [...res.headers.entries()].filter(([name]) => name !== "date"),
    body: await res.text(),
    ms: performance.now() - started,
  };
}

const signUp = (email: string, locale?: string) =>
  post("/sign-up/email", { name: "Same Name", email, password: "same-password-12345" }, locale);

async function settled(predicate: () => boolean) {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5_000, interval: 10 });
}

function callbackOf(url: string): string | null {
  return new URL(url).searchParams.get("callbackURL");
}

beforeEach(() => {
  mail.rendered.length = 0;
  mail.sent.length = 0;
  mail.mode = "ok";
});

afterAll(async () => {
  await prisma.$disconnect();
  await database.close();
  await cluster.close();
});

describe("sign-up verification mail", () => {
  it("is sent after the user row commits, in the signer's locale", async () => {
    expect((await signUp("first-admin@example.test")).body).toBe(NEUTRAL);
    await settled(() => mail.sent.length === 1);
    mail.rendered.length = 0;
    mail.sent.length = 0;

    for (const locale of ["es-MX", "en-US"] as const) {
      const email = `signer-${locale.toLowerCase()}@example.test`;
      const res = await signUp(email, locale);
      expect(res).toMatchObject({ status: 200, body: NEUTRAL });
      await settled(() => mail.sent.some((sent) => sent.to === email));
      expect(mail.sent.find((sent) => sent.to === email)).toEqual({
        to: email,
        userVisible: true,
        locale,
      });
      const rendered = mail.rendered.at(-1);
      expect(rendered?.locale).toBe(locale);
      expect(callbackOf(rendered!.url)).toBe(`/${locale}/verify-email?ok=1`);
      expect(await prisma.user.findUnique({ where: { email }, select: { locale: true } })).toEqual({
        locale,
      });
    }
  });

  it("answers a new address like a registered one while SMTP hangs or fails, and keeps the account", async () => {
    await signUp("registered@example.test");
    await settled(() => mail.sent.length === 1);

    mail.mode = "hang";
    const registered = await signUp("registered@example.test", "es-MX");
    const fresh = await signUp("new-during-outage@example.test", "es-MX");
    expect(fresh.status).toBe(200);
    expect(fresh.body).toBe(NEUTRAL);
    const shape = (r: typeof fresh) => ({ status: r.status, headers: r.headers, body: r.body });
    expect(shape(registered)).toEqual(shape(fresh));
    expect(fresh.headers.some(([name]) => name === "set-cookie")).toBe(false);
    // Well below one SMTP timeout: the request does not wait for the mail.
    expect(fresh.ms).toBeLessThan(3_000);
    expect(
      await prisma.user.findUnique({
        where: { email: "new-during-outage@example.test" },
        select: { locale: true, emailVerified: true },
      }),
    ).toEqual({ locale: "es-MX", emailVerified: false });

    const log = captureLog();
    try {
      mail.mode = "fail";
      const failed = await signUp("new-smtp-down@example.test", "es-MX");
      expect({ status: failed.status, headers: failed.headers, body: failed.body }).toEqual(
        shape(fresh),
      );
      await settled(() => log.records.some((r) => r.site === "auth.verification-email"));
      const record = log.records.find((r) => r.site === "auth.verification-email");
      expect(record).toMatchObject({ level: "error", errorClass: "Error" });
      expect(JSON.stringify(record)).not.toContain("ETIMEDOUT");
    } finally {
      log.restore();
    }

    // The re-send endpoint is not detached: it still reports a failed send.
    mail.mode = "fail";
    const refused = await post("/send-verification-email", { email: "new-smtp-down@example.test" });
    expect(refused.status).toBeGreaterThanOrEqual(400);

    // SMTP back: the re-send endpoint mails the kept account in its locale.
    mail.mode = "ok";
    const resend = await post("/send-verification-email", { email: "new-smtp-down@example.test" });
    expect(resend.status).toBe(200);
    expect(mail.sent.at(-1)).toEqual({
      to: "new-smtp-down@example.test",
      userVisible: true,
      locale: "es-MX",
    });
    expect(callbackOf(mail.rendered.at(-1)!.url)).toBe("/es-MX/verify-email?ok=1");
  });
});
