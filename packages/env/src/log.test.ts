import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  captureLog,
  countMergeabilityFailure,
  LOG_SITES,
  type LogSite,
  logEvent,
  logInternalError,
  logRecord,
  logStartupFailure,
  setLogSink,
  validateLogRecord,
} from "./log";

const CANARY = "Zq7Kp2Xw9Lm4Rt8V";
const hostile = () =>
  Object.assign(
    new Error(`token=${CANARY} https://ada:${CANARY}@host {"password":"${CANARY}"}`, {
      cause: new Error(CANARY),
    }),
    { config: { headers: { authorization: `Bearer ${CANARY}` } } },
  );

describe("the process's only output: fixed records", () => {
  it.each(Object.keys(LOG_SITES) as LogSite[])(
    "%s: closed level, fixed message, no error text",
    (site) => {
      const log = captureLog();
      try {
        logInternalError(site, hostile(), { requestId: "req-1", kbId: "kb123" });
        const [level, message] = LOG_SITES[site];
        expect(["error", "warn", "info"]).toContain(level);
        expect(log.records).toEqual([
          { level, site, message, errorClass: "Error", requestId: "req-1", kbId: "kb123" },
        ]);
        expect(JSON.stringify(log.records)).not.toContain(CANARY);
      } finally {
        log.restore();
      }
    },
  );

  it("produces only records the supervisor's validator accepts unchanged", () => {
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error(CANARY);
        },
      },
    );
    const errors: unknown[] = [
      undefined,
      null,
      "oops",
      42,
      10n,
      true,
      Symbol(CANARY),
      () => CANARY,
      trap,
      hostile(),
      Object.assign(new Error(CANARY), { code: "57014" }),
      Object.assign(new Error(CANARY), { code: 128, status: "lower-case" }),
    ];
    // Detail values that fit some detail shape but not every key's own rule.
    for (const value of ["57014", "2.45", "2.45.0", "TypeError", "EIO", `x ${CANARY}`, 7, 1.5])
      errors.push(
        Object.assign(new Error(CANARY), {
          logDetail: () => ({
            hookErrorClass: value,
            hookErrorCode: value,
            gitVersion: value,
            minGitVersion: value,
            setting: value,
            reason: value,
          }),
        }),
      );
    const fieldSets = [
      {},
      { requestId: "req-1", kbId: "kb1", route: "/git/:kbId/*", status: 500, durationMs: 1.5 },
      { requestId: `id ${CANARY}`, route: `/x?token=${CANARY}`, attempt: Number.NaN },
    ];
    for (const site of Object.keys(LOG_SITES) as LogSite[])
      for (const error of errors)
        for (const fields of fieldSets) {
          const record = logRecord(site, fields, error);
          expect(validateLogRecord(record)).toEqual(record);
          expect(JSON.stringify(record)).not.toContain(CANARY);
        }
  });

  it("keeps a thrown primitive's correlating fields (closed class names)", () => {
    const log = captureLog();
    try {
      logInternalError("mcp.tool", "oops", { requestId: "req-1", kbId: "kb1" });
      logInternalError("mcp.tool", null, { requestId: "req-2" });
      expect(log.records).toEqual([
        {
          level: "error",
          site: "mcp.tool",
          message: LOG_SITES["mcp.tool"][1],
          errorClass: "String",
          requestId: "req-1",
          kbId: "kb1",
        },
        {
          level: "error",
          site: "mcp.tool",
          message: LOG_SITES["mcp.tool"][1],
          errorClass: "Null",
          requestId: "req-2",
        },
      ]);
    } finally {
      log.restore();
    }
  });

  it("validates wire records against the closed schema", () => {
    const record = logRecord("server.startup", { stage: "import" }, new Error(CANARY));
    expect(validateLogRecord(record)).toEqual(record);
    for (const value of [
      null,
      [],
      {},
      { ...record, message: CANARY },
      { ...record, level: "info" },
      { ...record, extra: CANARY },
      { ...record, site: "constructor" },
      { ...record, errorCode: `token=${CANARY}` },
    ])
      expect(validateLogRecord(value)).toBeUndefined();
  });

  it("drops field values, codes and class names that are not identifier-like", () => {
    const pat = `kbp_${"a".repeat(16)}_${"b".repeat(43)}`;
    const error = Object.assign(new Error("x"), { code: pat });
    Object.defineProperty(error, "constructor", { value: { name: pat } });
    const record = logRecord(
      "git-http",
      { requestId: `id ${CANARY}`, opId: "op-1", kbId: "https://ada:x@host" },
      error,
    );
    expect(record).toEqual({
      level: "error",
      site: "git-http",
      message: LOG_SITES["git-http"][1],
      errorClass: "Unknown",
      opId: "op-1",
    });
    expect(logRecord("http.request", { route: `/reset?token=${CANARY}` }).route).toBeUndefined();
    expect(logRecord("http.request", { route: "/git/:kbId{[a-z0-9]+}/*" }).route).toBe(
      "/git/:kbId{[a-z0-9]+}/*",
    );
  });

  it("takes typed detail only from logDetail(), validated", () => {
    const error = Object.assign(new Error(CANARY), {
      logDetail: () => ({ hookErrorClass: "TypeError", hookErrorCode: "EIO", bad: `x ${CANARY}` }),
    });
    const record = logRecord("git-http", {}, error);
    expect(record).toMatchObject({ hookErrorClass: "TypeError", hookErrorCode: "EIO" });
    expect(JSON.stringify(record)).not.toContain(CANARY);
  });

  it("survives hostile thrown values and a broken sink", () => {
    const trap = new Proxy(
      {},
      {
        get() {
          throw new Error(CANARY);
        },
      },
    );
    const log = captureLog();
    try {
      for (const value of [trap, null, undefined, CANARY, 42, Symbol(CANARY)])
        expect(() => logInternalError("mcp.tool", value)).not.toThrow();
      expect(JSON.stringify(log.records)).not.toContain(CANARY);
    } finally {
      log.restore();
    }
    const restore = setLogSink(() => {
      throw new Error("sink down");
    });
    try {
      expect(() => logEvent("worker.started")).toThrow();
    } finally {
      restore();
    }
  });

  it("keeps a driver's connect failure code and the caller's stage, never a configuration label", () => {
    const log = captureLog();
    try {
      for (const code of ["ECONNREFUSED", "28P01", "3D000", "57P03"])
        logStartupFailure(
          "server",
          Object.assign(new Error(`password=${CANARY}`), { code }),
          "maintenance",
        );
      expect(log.records.map((record) => [record.stage, record.errorCode])).toEqual([
        ["maintenance", "ECONNREFUSED"],
        ["maintenance", "28P01"],
        ["maintenance", "3D000"],
        ["maintenance", "57P03"],
      ]);
      for (const record of log.records) {
        expect(record).not.toHaveProperty("setting");
        expect(record).not.toHaveProperty("reason");
      }
      expect(JSON.stringify(log.records)).not.toContain(CANARY);
    } finally {
      log.restore();
    }
  });

  it("names the startup stage, and an unsupported git gets its own record", async () => {
    const log = captureLog();
    try {
      logStartupFailure("server", new Error(CANARY), "data-root");
      logStartupFailure(
        "worker",
        Object.assign(new Error(CANARY), {
          code: "UNSUPPORTED_GIT",
          logDetail: () => ({ gitVersion: "2.39.5", minGitVersion: "2.45.0" }),
        }),
        "git",
      );
      expect(log.records).toEqual([
        {
          level: "error",
          site: "server.startup",
          message: "server startup failed",
          errorClass: "Error",
          stage: "data-root",
        },
        {
          level: "error",
          site: "git.unsupported",
          message: "git >= 2.45 is required; use the trixie-based images",
          errorClass: "Error",
          errorCode: "UNSUPPORTED_GIT",
          stage: "git",
          gitVersion: "2.39.5",
          minGitVersion: "2.45.0",
        },
      ]);
      expect(JSON.stringify(log.records)).not.toContain(CANARY);
    } finally {
      log.restore();
    }
  });

  it("counts mergeability failures for the process", () => {
    const first = countMergeabilityFailure();
    expect(countMergeabilityFailure()).toBe(first + 1);
  });
});

describe("record channel", () => {
  const module = (name: string) => JSON.stringify(new URL(name, import.meta.url).href);
  const run = (body: string, stdio: ("pipe" | "ignore")[], env: Record<string, string> = {}) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `const log = await import(${module("./log.ts")});\n${body}`,
      ],
      { encoding: "utf8", stdio, timeout: 20_000, env: { PATH: process.env.PATH, ...env } },
    );
  const records = (text: string) =>
    text
      .split("\n")
      .filter(Boolean)
      .map((line) => validateLogRecord(JSON.parse(line)));

  it("works in any host with no setup: records go to stderr", () => {
    // A CLI, `vite dev`, a test's child or a script: nothing to connect, and
    // loading the logger never throws.
    const result = run(`log.logEvent("worker.started");`, ["ignore", "pipe", "pipe"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(records(result.stderr)).toEqual([logRecord("worker.started")]);
  });

  it("logs env validation warnings from library callbacks without throwing", () => {
    // A dev environment whose validation logs warnings inside a zod refinement.
    const result = run(
      `process.on("unhandledRejection", () => { process.stdout.write("unhandled"); process.exit(9); });
       await import(${module("./shared.ts")}); process.stdout.write("loaded");`,
      ["ignore", "pipe", "pipe"],
      {
        NODE_ENV: "development",
        BACKUP_ENABLED: "true",
        DATABASE_URL: "postgresql://kb:kb@localhost:5432/kb",
        REDIS_URL: "redis://localhost:6379",
      },
    );
    expect(result.stdout).toBe("loaded");
    expect(result.status).toBe(0);
    expect(records(result.stderr)).toContainEqual(
      expect.objectContaining({ site: "backup.config" }),
    );
  });

  it("never throws when stderr is closed", () => {
    const result = run(`log.logEvent("worker.started"); process.stdout.write("alive");`, [
      "ignore",
      "pipe",
      "ignore",
    ]);
    expect(result.stdout).toBe("alive");
    expect(result.status).toBe(0);
  });

  it("refuses to assume a service channel the supervisor did not name", () => {
    const attempt = `try { log.connectServiceLog(); process.stdout.write("connected"); }
       catch (error) { process.stdout.write(error.code); }`;
    // fd 3 is a pipe, but nothing named it.
    expect(run(attempt, ["ignore", "pipe", "pipe", "pipe"]).stdout).toBe("LOG_CHANNEL_UNAVAILABLE");
    // Named, but not open (or not a pipe/socket, such as the fence file).
    expect(run(attempt, ["ignore", "pipe", "pipe"], { KB_LOG_FD: "3" }).stdout).toBe(
      "LOG_CHANNEL_UNAVAILABLE",
    );
  });

  it("a connected service writes only to its channel, never stdout or stderr", () => {
    const result = run(
      `log.connectServiceLog();
       log.logEvent("worker.started");`,
      ["ignore", "pipe", "pipe", "pipe"],
      { KB_LOG_FD: "3" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(records(String(result.output[3]))).toEqual([logRecord("worker.started")]);
  });
});
