import { format, inspect } from "node:util";
import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { ENV_VARS } from "../../../scripts/lib/env-manifest";
import { Secret } from "./secret";
import { serverVars } from "./vars/server";
import { sharedVars } from "./vars/shared";

const CANARY = "Zq7Kp2Xw9Lm4Rt8V";

describe("Secret cannot render", () => {
  const secret = new Secret(CANARY);
  const holders: [string, unknown][] = [
    ["bare", secret],
    ["object", { auth: { user: "ada", pass: secret } }],
    ["array", [secret, { nested: [secret] }]],
    ["map", new Map([["SMTP_PASS", secret]])],
    ["error property", Object.assign(new Error("smtp failed"), { config: { pass: secret } })],
    ["error cause", new Error("outer", { cause: { token: secret } })],
  ];
  it.each(holders)("%s: inspect, JSON, template, String, console formatting", (_name, holder) => {
    const renders = [
      inspect(holder, { depth: 10, showHidden: true }),
      JSON.stringify(holder, (_key, value: unknown) =>
        value instanceof Map ? Object.fromEntries(value) : value,
      ),
      `${holder instanceof Secret ? holder : inspect(holder)}`,
      String(holder instanceof Secret ? holder : inspect(holder)),
      format("%s %o %O %j", holder, holder, holder, holder),
      format(holder),
    ];
    for (const text of renders) expect(text).not.toContain(CANARY);
    expect(renders[0]).toContain("[redacted]");
  });

  it("coerces to [redacted] and reveals only on request", () => {
    expect(`${secret}`).toBe("[redacted]");
    expect(String(secret)).toBe("[redacted]");
    expect(`${secret}` + "").toBe("[redacted]");
    expect(JSON.stringify({ secret })).toBe('{"secret":"[redacted]"}');
    expect(Object.keys(secret)).toEqual([]);
    expect(secret.reveal()).toBe(CANARY);
    expect(Object.isFrozen(secret)).toBe(true);
  });
});

/** A value each secret's schema accepts, for the parse below. */
const SAMPLES = [
  "Zq7Kp2Xw9Lm4Rt8V-Zq7Kp2Xw9Lm4Rt8V-Zq7Kp2Xw9Lm4Rt8V",
  Buffer.alloc(32, 7).toString("base64"),
  "postgresql://kb:secret@db.invalid:5432/kb",
  "redis://default:secret@redis.invalid:6379",
];

describe("every secret-classified env key is typed Secret", () => {
  const schema: Record<string, ZodType> = { ...sharedVars, ...serverVars };
  const secretKeys = ENV_VARS.filter((v) => v.secret).map((v) => v.key);

  it("the manifest classifies the app's credentials as secret", () => {
    for (const key of [
      "BETTER_AUTH_SECRET",
      "SMTP_PASS",
      "SSO_CLIENT_SECRET",
      "KB_MASTER_KEY",
      "VAPID_PRIVATE_KEY",
      "DATABASE_URL",
      "REDIS_URL",
      "OPENROUTER_API_KEY",
      "ANTHROPIC_API_KEY",
      "BACKUP_S3_ACCESS_KEY_ID",
      "BACKUP_S3_SECRET_ACCESS_KEY",
      "BACKUP_MONITOR_S3_ACCESS_KEY_ID",
      "BACKUP_MONITOR_S3_SECRET_ACCESS_KEY",
    ])
      expect(secretKeys).toContain(key);
  });

  it.each(secretKeys.filter((key) => key in schema))("%s parses to a Secret", (key) => {
    const parsed = SAMPLES.map((sample) => schema[key]!.safeParse(sample)).find((r) => r.success);
    expect(parsed, `no sample parses for ${key}`).toBeDefined();
    expect(parsed!.data).toBeInstanceOf(Secret);
    expect(inspect(parsed!.data)).toBe("[redacted]");
  });

  it("no secret is left outside the schemas unless read only by a shell entrypoint", () => {
    const outside = ENV_VARS.filter((v) => v.secret && !(v.key in schema));
    for (const entry of outside) expect(entry.inSchema, entry.key).toBe(false);
  });
});

describe("connection strings retain driver syntax", () => {
  it.each([
    ["DATABASE_URL", "postgresql://kb@/kb?host=%2Fvar%2Frun%2Fpostgresql"],
    ["DATABASE_URL", "socket:/var/run/postgresql?db=kb"],
    ["DATABASE_URL", "postgresql:///kb?host=/var/run/postgresql"],
    ["REDIS_URL", "redis:///3"],
    ["REDIS_URL", "redis://default:malformed%zz@localhost"],
    ["DATABASE_URL", "postgresql://kb:malformed%zz@localhost/kb"],
  ] as const)("%s preserves %s for its driver", (setting, value) => {
    expect(sharedVars[setting].parse(value).reveal()).toBe(value);
  });
  it.each(["DATABASE_URL", "REDIS_URL"] as const)("%s remains required", (setting) => {
    for (const value of [undefined, ""])
      expect(sharedVars[setting].safeParse(value).success).toBe(false);
  });
});
