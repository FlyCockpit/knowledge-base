import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogRecord } from "./log";

// server.ts validates process.env and runs its startup guards as import-time
// side effects, so every case re-imports a freshly reset module under a fully
// controlled environment. The helper snapshots and restores process.env so
// cases cannot leak state into each other or the surrounding test run.

type EnvMap = Record<string, string | undefined>;

const BASE_ENV: EnvMap = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://localhost:5432/test",
  REDIS_URL: "redis://localhost:6379",
  // Strong enough for the entropy check: >10 distinct characters, no
  // placeholder words, no repeating pattern.
  BETTER_AUTH_SECRET: "kV3mQ7xZ2bN9wL5pR8tY4cJ6hF1dS0gU",
  // https, so the production-only http:// guards stay out of the way.
  BETTER_AUTH_URL: "https://app.example.com",
  // Every optional key the startup guards read starts explicitly undefined,
  // so a value exported in the developer's shell cannot skew a case.
  ADMIN_EMAIL: undefined,
  SIGNUP_ENABLED: undefined,
  SSO_ENABLED: undefined,
  SSO_CLIENT_ID: undefined,
  SSO_CLIENT_SECRET: undefined,
  SSO_ISSUER: undefined,
  FORCE_SSO: undefined,
  VAPID_PUBLIC_KEY: undefined,
  VAPID_PRIVATE_KEY: undefined,
  VAPID_SUBJECT: undefined,
  SMTP_HOST: undefined,
  SMTP_FROM: undefined,
  DATABASE_POOL_MAX: undefined,
  KB_MASTER_KEY: undefined,
  KB_DATA_ROOT: undefined,
};

const ENV_SNAPSHOT: EnvMap = { ...process.env };

async function importServerEnv(overrides: EnvMap = {}): Promise<typeof import("./server.js")> {
  const effective: EnvMap = { ...BASE_ENV, ...overrides };
  for (const [key, value] of Object.entries(effective)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await import("./server.js");
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in ENV_SNAPSHOT)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(ENV_SNAPSHOT)) {
      process.env[key] = value;
    }
  }
}

/** Capture records at the child logger channel rather than its inherited stderr. */
let records: LogRecord[];
let restoreLog: () => void;
function configReasons(records: LogRecord[]): string[] {
  return records.flatMap((record) =>
    record.site === "server.config" && typeof record.reason === "string" ? [record.reason] : [],
  );
}

function lockoutMessage(warn: LogRecord[]) {
  return configReasons(warn).includes("NO_BOOTSTRAP_ADMIN");
}

function productionUnsetMessage(warn: LogRecord[]) {
  return configReasons(warn).includes("ADMIN_EMAIL_UNSET");
}

beforeEach(async () => {
  vi.resetModules();
  const log = (await import("./log")).captureLog();
  records = log.records;
  restoreLog = log.restore;
});

afterEach(() => {
  restoreLog();
  vi.restoreAllMocks();
});

describe("server env — rate-limit budget defaults", () => {
  it("defaults every budget to its family reference (collapse is behavior-neutral)", async () => {
    const mod = await importServerEnv();
    expect(mod.env.RATE_LIMIT_AUTH_POINTS).toBe(30);
    expect(mod.env.RATE_LIMIT_AUTH_WINDOW_SECONDS).toBe(60);
    expect(mod.env.RATE_LIMIT_RPC_POINTS).toBe(100);
    expect(mod.env.RATE_LIMIT_RPC_WINDOW_SECONDS).toBe(60);
    expect(mod.env.RATE_LIMIT_EMAIL_POINTS).toBe(3);
    expect(mod.env.RATE_LIMIT_EMAIL_WINDOW_SECONDS).toBe(3600);
  });

  it("accepts 0 points for RATE_LIMIT_EMAIL_POINTS — the documented family disable", async () => {
    const mod = await importServerEnv({ RATE_LIMIT_EMAIL_POINTS: "0" });
    expect(mod.env.RATE_LIMIT_EMAIL_POINTS).toBe(0);
  });

  it("rejects a non-positive budget points/window", async () => {
    await expect(importServerEnv({ RATE_LIMIT_AUTH_POINTS: "0" })).rejects.toThrow();
    await expect(importServerEnv({ RATE_LIMIT_AUTH_WINDOW_SECONDS: "0" })).rejects.toThrow();
  });
});

describe("shared env — DATABASE_POOL_MAX", () => {
  it("defaults to the node-postgres default of 10", async () => {
    const mod = await importServerEnv();
    expect(mod.env.DATABASE_POOL_MAX).toBe(10);
  });

  it("accepts a positive integer", async () => {
    const mod = await importServerEnv({ DATABASE_POOL_MAX: "25" });
    expect(mod.env.DATABASE_POOL_MAX).toBe(25);
  });

  it("rejects zero, negative, and non-numeric values", async () => {
    await expect(importServerEnv({ DATABASE_POOL_MAX: "0" })).rejects.toThrow();
    await expect(importServerEnv({ DATABASE_POOL_MAX: "-5" })).rejects.toThrow();
    await expect(importServerEnv({ DATABASE_POOL_MAX: "many" })).rejects.toThrow();
  });
});

describe("server env startup guards — admin lockout", () => {
  it("warns (never throws) in production when ADMIN_EMAIL is unset — provisioned installs keep their DB admins", async () => {
    const warn = records;
    const mod = await importServerEnv({ NODE_ENV: "production" });
    expect(mod.ADMIN_EMAIL).toBeUndefined();
    expect(productionUnsetMessage(warn)).toBe(true);
  });

  it("treats an empty-string ADMIN_EMAIL as unset (lockout still warns)", async () => {
    const warn = records;
    const mod = await importServerEnv({ NODE_ENV: "production", ADMIN_EMAIL: "" });
    expect(mod.ADMIN_EMAIL).toBeUndefined();
    expect(productionUnsetMessage(warn)).toBe(true);
  });

  it("still warns with SSO fully configured — SSO is not an admin escape hatch", async () => {
    const warn = records;
    const mod = await importServerEnv({
      NODE_ENV: "production",
      SSO_ENABLED: "true",
      SSO_CLIENT_ID: "client-id",
      SSO_CLIENT_SECRET: "sS0oW9eA1kZ3cR4eT5vB6nM7qP8xY2zQ4uV0wE",
      SSO_ISSUER: "https://sso.example.com",
      FORCE_SSO: "true",
    });
    expect(mod.ADMIN_EMAIL).toBeUndefined();
    expect(productionUnsetMessage(warn)).toBe(true);
  });

  it("warns in production even when SIGNUP_ENABLED=true — bootstrap still needs ADMIN_EMAIL", async () => {
    const warn = records;
    const mod = await importServerEnv({
      NODE_ENV: "production",
      SIGNUP_ENABLED: "true",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "App <no-reply@example.com>",
    });
    expect(mod.ADMIN_EMAIL).toBeUndefined();
    expect(lockoutMessage(warn)).toBe(false);
    expect(productionUnsetMessage(warn)).toBe(true);
  });

  it("does not throw in dev — the lockout shape only warns", async () => {
    const warn = records;
    const mod = await importServerEnv({ NODE_ENV: "development" });
    expect(mod.ADMIN_EMAIL).toBeUndefined();
    expect(lockoutMessage(warn)).toBe(true);
  });

  it("boots fine with a populated ADMIN_EMAIL, trimmed and lowercased", async () => {
    const warn = records;
    const mod = await importServerEnv({
      NODE_ENV: "production",
      ADMIN_EMAIL: "  Admin@Example.com  ",
    });
    expect(mod.ADMIN_EMAIL).toBe("admin@example.com");
    expect(warn.some((record) => record.setting === "ADMIN_EMAIL")).toBe(false);
  });

  it("rejects multiple comma-separated addresses — ADMIN_EMAIL is one identity", async () => {
    await expect(
      importServerEnv({
        NODE_ENV: "production",
        ADMIN_EMAIL: "admin@example.com,other@example.com",
      }),
    ).rejects.toThrow();
  });
});

describe("server env — dedicated worker topology", () => {
  it("defaults volume roots", async () => {
    const mod = await importServerEnv();
    expect(mod.env.KB_DATA_ROOT).toBe("/var/lib/knowledge-base");
    expect(mod.env.KB_RUNTIME_UID).toBe(1000);
    expect(mod.env.KB_MASTER_KEY).toBeUndefined();
  });

  it("accepts a 32-byte base64 master key", async () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    const withKey = await importServerEnv({ KB_MASTER_KEY: key });
    expect(withKey.env.KB_MASTER_KEY?.reveal()).toBe(key);
  });

  it("rejects a master key that is not 32 decoded bytes", async () => {
    await expect(importServerEnv({ KB_MASTER_KEY: "not-32-bytes" })).rejects.toThrow(
      /Invalid environment variables/,
    );
  });

  it("rejects permissive-base64 junk the canonical validator rejects", async () => {
    // Buffer.from ignores the "!" so a length-only check accepts this value;
    // the encryption helper refuses it, and the runtime schema must agree.
    const key = Buffer.alloc(32, 7).toString("base64");
    await expect(importServerEnv({ KB_MASTER_KEY: `!${key}` })).rejects.toThrow(
      /Invalid environment variables/,
    );
  });
});

describe("server env — resolveAppName", () => {
  it("defaults to App when unset or empty (Docker exports empty-string ARGs)", async () => {
    const mod = await importServerEnv();
    expect(mod.resolveAppName(undefined)).toBe("KnowledgeBase");
    expect(mod.resolveAppName("")).toBe("KnowledgeBase");
  });

  it("passes through a configured name via the canonical web schema", async () => {
    const mod = await importServerEnv();
    expect(mod.resolveAppName("Acme")).toBe("Acme");
  });

  it("fails fast on names the client schema rejects", async () => {
    const mod = await importServerEnv();
    try {
      mod.resolveAppName("x".repeat(81));
      throw new Error("expected validation to fail");
    } catch (error) {
      const { logRecord } = await import("./log.js");
      expect(logRecord("server.startup", {}, error)).toMatchObject({
        setting: "VITE_APP_NAME",
        reason: "TOO_BIG",
        errorCode: "INVALID_ENV",
      });
    }
  });
});

describe("server env startup guards — SSO_CLIENT_SECRET entropy", () => {
  const STRONG_SSO_SECRET = "sS0oW9eA1kZ3cR4eT5vB6nM7qP8xY2zQ4uV0wE";

  function ssoWarning(warn: LogRecord[]) {
    return warn.some(
      (record) => record.setting === "SSO_CLIENT_SECRET" && record.reason === "WEAK_SECRET",
    );
  }

  // One import per case: server.ts runs its guards as import-time side
  // effects, so a second import in the same test would hit the module cache
  // and never re-run them.
  it.each([["changeme"], ["my-secret-value"], ["xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"]])(
    "warns in dev for placeholder SSO secret %s",
    async (placeholder) => {
      const warn = records;
      await importServerEnv({ NODE_ENV: "development", SSO_CLIENT_SECRET: placeholder });
      expect(ssoWarning(warn)).toBe(true);
    },
  );

  it("throws in production for placeholder SSO secrets", async () => {
    await expect(
      importServerEnv({ NODE_ENV: "production", SSO_CLIENT_SECRET: "changeme" }),
    ).rejects.toMatchObject({
      code: "INVALID_ENV",
      issues: [{ setting: "SSO_CLIENT_SECRET", reason: "WEAK_SECRET" }],
    });
  });

  it("stays silent when SSO_CLIENT_SECRET is unset (SSO inert)", async () => {
    const warn = records;
    await importServerEnv({ NODE_ENV: "development" });
    expect(ssoWarning(warn)).toBe(false);
  });

  it("stays silent for a strong SSO secret in dev and prod", async () => {
    const warn = records;
    await importServerEnv({
      NODE_ENV: "development",
      SSO_CLIENT_SECRET: STRONG_SSO_SECRET,
    });
    expect(ssoWarning(warn)).toBe(false);
    warn.length = 0;
    const mod = await importServerEnv({
      NODE_ENV: "production",
      ADMIN_EMAIL: "admin@example.com",
      SSO_CLIENT_SECRET: STRONG_SSO_SECRET,
    });
    expect(mod.env.SSO_CLIENT_SECRET?.reveal()).toBe(STRONG_SSO_SECRET);
    expect(ssoWarning(warn)).toBe(false);
  });
});

describe("production guards carry closed configuration detail", () => {
  it.each([
    ["BETTER_AUTH_URL", "HTTPS_REQUIRED", { BETTER_AUTH_URL: "http://app.example.com" }],
    ["CORS_ORIGIN", "HTTPS_REQUIRED", { CORS_ORIGIN: "http://app.example.com" }],
    ["PUBLIC_APP_URL", "HTTPS_REQUIRED", { PUBLIC_APP_URL: "http://app.example.com" }],
    ["BETTER_AUTH_SECRET", "WEAK_SECRET", { BETTER_AUTH_SECRET: "x".repeat(32) }],
    ["SSO_CLIENT_SECRET", "WEAK_SECRET", { SSO_CLIENT_SECRET: "changeme" }],
    ["SMTP_FROM", "SMTP_FROM_MISSING", { SMTP_HOST: "smtp.example.com" }],
    ["SMTP_HOST", "SIGNUP_WITHOUT_SMTP", { SIGNUP_ENABLED: "true" }],
    ["SSO_ENABLED", "REQUIRED_FOR_FORCE_SSO", { FORCE_SSO: "true" }],
    ["VAPID_PRIVATE_KEY", "VAPID_PARTIAL", { VAPID_PUBLIC_KEY: "public" }],
  ])("%s is distinguishable without exception prose", async (setting, reason, overrides) => {
    const { logRecord } = await import("./log.js");
    let record: ReturnType<typeof logRecord> | undefined;
    try {
      await importServerEnv({
        NODE_ENV: "production",
        CORS_ORIGIN: undefined,
        PUBLIC_APP_URL: undefined,
        ...overrides,
      });
    } catch (error) {
      record = logRecord("server.startup", { stage: "import" }, error);
    }
    expect(record).toMatchObject({
      errorClass: "EnvValidationError",
      errorCode: "INVALID_ENV",
      setting,
      reason,
    });
  });
});

describe("asset S3 startup validation", () => {
  const asset = {
    KB_ASSET_S3_ENABLED: "true",
    KB_ASSET_CACHE_MAX_BYTES: "26214400",
    KB_ASSET_S3_BUCKET: "fixture-assets",
    KB_ASSET_S3_REGION: "us-east-1",
    KB_ASSET_S3_ACCESS_KEY_ID: "fixture-writer",
  };
  it("requires server credentials even in development and accepts a wrapped secret", async () => {
    await expect(
      importServerEnv({ ...asset, KB_ASSET_S3_SECRET_ACCESS_KEY: undefined }),
    ).rejects.toThrow("Invalid environment variables");
    vi.resetModules();
    const result = await importServerEnv({
      ...asset,
      KB_ASSET_S3_SECRET_ACCESS_KEY: "fixture-secret",
    });
    expect(result.env.KB_ASSET_S3_SECRET_ACCESS_KEY?.toString()).toBe("[redacted]");
  });
  it("rejects malformed opt-in booleans", async () => {
    await expect(importServerEnv({ KB_ASSET_S3_ENABLED: "yes" })).rejects.toThrow(
      "Invalid environment variables",
    );
  });
  it("ignores incomplete optional settings when off", async () => {
    const result = await importServerEnv({
      KB_ASSET_S3_ENABLED: "false",
      KB_ASSET_S3_FORCE_PATH_STYLE: "yes",
      KB_ASSET_CACHE_MAX_BYTES: "bad",
    });
    expect(result.env.KB_ASSET_S3_ENABLED).toBe(false);
  });
});
