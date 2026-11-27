import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { PasswordPepperKeyError, pepperFingerprint } from "../packages/auth/src/password-pepper.ts";

// Exercise the read-only probe without importing doctor's CLI main (which
// validates the local env, starts network probes, and exits the process).
const source = readFileSync(new URL("./doctor.ts", import.meta.url), "utf8");
const start = source.indexOf("function checkPasswordPepper()");
const end = source.indexOf("// 3. Database connection", start);
assert.ok(start > 0 && end > start);
const probe = stripTypeScriptTypes(source.slice(start, end));
const secret = "disposable-doctor-unit-test-key-0123456789";
const previousSecret = "disposable-doctor-previous-key-9876543210";
const fingerprint = pepperFingerprint(secret);
const previousFingerprint = pepperFingerprint(previousSecret);
type Count = { kind: string; fingerprint: string; count: number };
type Result = { name: string; status: string; detail: string; hint?: string };

function check(
  options: {
    rows?: Count[];
    secret?: string;
    previous?: string;
    databaseOk?: boolean;
    output?: string;
    ok?: boolean;
  } = {},
) {
  const results: Result[] = [];
  const calls: { filter: string; script: string; env: Record<string, string> }[] = [];
  runInNewContext(`${probe}\ncheckPasswordPepper();`, {
    process: {
      env: {
        BETTER_AUTH_SECRET: options.secret ?? secret,
        BETTER_AUTH_SECRET_PREVIOUS: options.previous,
      },
    },
    pepperFingerprint,
    PasswordPepperKeyError,
    results: [{ name: "database", status: options.databaseOk === false ? "fail" : "ok" }],
    record: (result: Result) => results.push(result),
    runInPackage: (filter: string, script: string, env: Record<string, string>) => {
      calls.push({ filter, script, env });
      return {
        ok: options.ok ?? true,
        output: options.output ?? JSON.stringify(options.rows ?? []),
      };
    },
  });
  const result = results[0];
  assert.ok(result);
  assert.equal(result.name, "password pepper");
  return { result, calls };
}

test("password pepper reports current key and counts, and passes only fingerprints to pg", () => {
  const { result, calls } = check({ rows: [{ kind: "current", fingerprint, count: 7 }] });
  assert.equal(result.status, "ok");
  assert.match(result.detail, new RegExp(`ok \\(key fp ${fingerprint}\\)`));
  assert.match(result.detail, /current 7, previous 0, legacy 0, malformed 0, unknown 0/);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.filter, "@knowledge-base/db");
  assert.equal(call.env.PEPPER_CURRENT_FP, fingerprint);
  assert.equal(call.env.PEPPER_PREVIOUS_FP, "");
  assert.equal(JSON.stringify(call).includes(secret), false);
  assert.match(call.script, /GROUP BY kind, fingerprint/);
  assert.ok(call.script.includes("^pw1:[0-9a-f]{16}:[A-Za-z0-9_-]{39,}$"));
  assert.match(result.detail, /invalid envelopes 0; authenticity is checked at server start/);
  assert.match(call.script, /FROM account WHERE password IS NOT NULL/);
  assert.doesNotMatch(call.script, /UPDATE|DELETE|INSERT/);
});

test("password pepper warns about previous, legacy, and malformed hashes", () => {
  const { result, calls } = check({
    previous: previousSecret,
    rows: [
      { kind: "previous", fingerprint: previousFingerprint, count: 2 },
      { kind: "legacy", fingerprint: "", count: 3 },
      { kind: "malformed", fingerprint: "", count: 1 },
    ],
  });
  assert.equal(result.status, "warn");
  assert.ok(
    result.hint?.includes(
      `2 hashes still under previous key ${previousFingerprint}; keep BETTER_AUTH_SECRET_PREVIOUS set and restart all servers to re-wrap`,
    ),
  );
  assert.match(result.hint ?? "", /3 hashes not yet sealed; the next server start seals them/);
  assert.match(result.hint ?? "", /1 malformed password values/);
  assert.equal(calls[0]?.env.PEPPER_PREVIOUS_FP, previousFingerprint);
  assert.equal(JSON.stringify({ result, calls }).includes(previousSecret), false);
});

test("password pepper fails on unknown keys with the startup error's recovery guidance", () => {
  const foreign = pepperFingerprint("disposable-foreign-doctor-key-1234567890");
  const { result } = check({
    previous: previousSecret,
    rows: [{ kind: "unknown-key", fingerprint: foreign, count: 4 }],
  });
  assert.equal(result.status, "fail");
  assert.equal(
    result.detail,
    new PasswordPepperKeyError(4, [foreign], [fingerprint, previousFingerprint]).message,
  );
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(previousSecret), false);
});

test("password pepper fails with no secret and skips an unreachable database", () => {
  const missing = check({ secret: "" });
  assert.equal(missing.result.status, "fail");
  assert.match(missing.result.detail, /BETTER_AUTH_SECRET is not set/);
  assert.equal(missing.calls.length, 0);
  const unreachable = check({ databaseOk: false });
  assert.equal(unreachable.result.status, "skip");
  assert.equal(unreachable.calls.length, 0);
});

test("password pepper fails closed on a failed probe or invalid output without echoing it", () => {
  for (const response of [
    { ok: false },
    { output: "invalid-json" },
    { output: "{}" },
    { rows: [{ kind: "unexpected", fingerprint: "", count: 1 }] },
    { rows: [{ kind: "unknown-key", fingerprint: "invalid", count: 1 }] },
  ]) {
    const { result } = check(response);
    assert.equal(result.status, "fail");
    assert.doesNotMatch(result.detail, /invalid-json|unexpected/);
  }
});

test("runInPackage strips pepper secrets from the child environment", () => {
  const start = source.indexOf("function runInPackage(");
  const end = source.indexOf("type CheckStatus", start);
  assert.ok(start > 0 && end > start);
  const fn = stripTypeScriptTypes(source.slice(start, end));
  let childEnv: Record<string, string | undefined> | undefined;
  runInNewContext(
    `${fn}\nrunInPackage('@knowledge-base/db', 'probe', { PEPPER_CURRENT_FP: 'fp' });`,
    {
      ROOT: "/fixture",
      process: {
        platform: "linux",
        env: {
          BETTER_AUTH_SECRET: secret,
          BETTER_AUTH_SECRET_PREVIOUS: previousSecret,
          DATABASE_URL: "fixture",
        },
      },
      spawnSync: (
        _command: string,
        _args: string[],
        options: { env: Record<string, string | undefined> },
      ) => {
        childEnv = options.env;
        return { status: 0, stdout: "ok" };
      },
    },
  );
  assert.ok(childEnv);
  assert.equal(childEnv.BETTER_AUTH_SECRET, undefined);
  assert.equal(childEnv.BETTER_AUTH_SECRET_PREVIOUS, undefined);
  assert.equal(childEnv.DATABASE_URL, "fixture");
  assert.equal(childEnv.PEPPER_CURRENT_FP, "fp");
});

test("password pepper reports invalid envelopes separately from key inventory", () => {
  const { result, calls } = check({
    rows: [
      { kind: "invalid-envelope", fingerprint: "", count: 8 },
      { kind: "current", fingerprint, count: 2 },
    ],
  });
  assert.equal(result.status, "warn");
  assert.match(
    result.detail,
    /current 2, previous 0, legacy 0, malformed 0, unknown 0, invalid envelopes 8/,
  );
  assert.match(
    result.hint ?? "",
    /8 structurally invalid password envelopes; run pnpm auth:pepper:reset-unusable/,
  );
  // Exercise the regex actually embedded in the SQL, without a live database.
  const script = calls[0]?.script ?? "";
  const pattern = /WHEN password ~ '([^']+)' THEN CASE/.exec(script)?.[1];
  assert.ok(pattern);
  const regex = new RegExp(pattern);
  const payload = "A".repeat(Math.ceil(((12 + 16 + 1) * 8) / 6));
  assert.ok(regex.test(`pw1:${fingerprint}:${payload}`));
  for (const value of [
    `pw1:${fingerprint}:`,
    `pw1:${fingerprint}:${Buffer.alloc(12 + 16).toString("base64url")}`,
    `pw1:${fingerprint}:!${payload}`,
    `pw1:${fingerprint}:${payload}=`,
    `pw1:${fingerprint.toUpperCase()}:${payload}`,
    `pw1:${fingerprint.slice(0, 15)}:${payload}`,
    `pw1:${fingerprint}0:${payload}`,
    `pw1:${fingerprint}:${payload}:extra`,
  ])
    assert.equal(regex.test(value), false);
  assert.match(script, /WHEN password LIKE 'pw1:%' THEN 'invalid-envelope'/);
  assert.match(script, /CASE WHEN password ~ '\^pw1:/);
});
