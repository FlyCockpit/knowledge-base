import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  byRole,
  type CheckRun,
  formSignIn,
  pollPage,
  sessionName,
  totpCode,
} from "./browser-check-lib.ts";
import {
  base32Bytes,
  DIALOGS,
  fixtureAccount,
  readFixture,
  SHELL_PAGES,
  signIn,
} from "./browser-checks.config.ts";
import { type DialogProbe, judgeDialog, stepScript } from "./check-dialogs.ts";

const fits: DialogProbe = {
  vw: 1280,
  vh: 800,
  popup: { top: 200, bottom: 600, left: 440, right: 840 },
  scrollers: [],
  covered: [],
};

describe("judgeDialog", () => {
  it("passes a dialog that shows all of itself inside the viewport", () => {
    assert.deepEqual(judgeDialog("Create project 1280×800", fits), []);
  });

  it("fails a dialog whose popup or a box inside it scrolls", () => {
    const bad = judgeDialog("Create sandbox 390×844", {
      ...fits,
      scrollers: [{ name: "[data-slot=dialog-content]", scrollHeight: 1900, clientHeight: 780 }],
    });
    assert.equal(bad.length, 1);
    assert.match(
      bad[0] ?? "",
      /\[data-slot=dialog-content\] scrolls \(1900px of content in 780px\)/,
    );
    assert.match(bad[0] ?? "", /page or a wide side sheet/);
  });

  it("fails a dialog whose action bar or header sits on top of its fields", () => {
    const bad = judgeDialog("Create project 1280×800", {
      ...fits,
      covered: [{ bar: "action bar", what: "p", overlap: 9 }],
    });
    assert.deepEqual(bad, ["Create project 1280×800: the action bar covers 9px of p"]);
  });

  it("fails a dialog that reaches outside the viewport", () => {
    for (const popup of [
      { top: -4, bottom: 600, left: 440, right: 840 },
      { top: 200, bottom: 801, left: 440, right: 840 },
      { top: 200, bottom: 600, left: -1, right: 840 },
      { top: 200, bottom: 600, left: 440, right: 1281 },
    ])
      assert.match(judgeDialog("x", { ...fits, popup })[0] ?? "", /outside the 1280×800 viewport/);
  });

  it("fails when no dialog opened", () => {
    assert.deepEqual(judgeDialog("x", { ...fits, popup: null }), ["x: no dialog opened"]);
  });
});

describe("browser-checks.config", () => {
  it("names every dialog once, with a locale path and at least one opening step", () => {
    const names = DIALOGS.map((dialog) => dialog.name);
    assert.equal(new Set(names).size, names.length);
    for (const dialog of DIALOGS) {
      assert.match(dialog.path, /^\/[a-z]{2}-[A-Z]{2}\//);
      assert.ok(dialog.steps.length > 0, dialog.name);
    }
  });

  it("measures at least two signed-in pages for the shell loading check", () => {
    assert.ok(SHELL_PAGES.length >= 2);
    for (const page of SHELL_PAGES) assert.notEqual(page.role, "anonymous", page.name);
  });

  it("turns steps into page scripts that fail loudly when the target is missing", () => {
    assert.match(stepScript({ click: "#a" }), /querySelector\("#a"\)/);
    assert.match(stepScript({ clickText: "New project" }), /"New project"/);
    assert.match(stepScript({ clickText: "x" }), /throw new Error/);
  });
});

const noPause = async () => {};
const navigated = () =>
  new Error(
    "agent-browser eval exited 1: ✗ CDP error (Runtime.evaluate): Inspected target navigated or closed",
  );

describe("pollPage", () => {
  /** A fake agent-browser: each eval answers with the next scripted reply (an Error is thrown). */
  const scripted = (replies: (string | Error)[]) => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply ?? "null";
    };
    return { run, calls };
  };

  it("keeps polling across the full page load a redirectTo sign-in ends in", async () => {
    const { run } = scripted(["null", '"/en-US/login"', navigated(), '"app"']);
    assert.equal(await pollPage(run, "probe", noPause), "app");
  });

  it("also looks again after a destroyed execution context", async () => {
    const destroyed = new Error(
      "agent-browser eval exited 1: ✗ CDP error (Runtime.evaluate): Execution context was destroyed.",
    );
    const { run } = scripted([destroyed, '"code"']);
    assert.equal(await pollPage(run, "probe", noPause), "code");
  });

  it("gives up after 20s with the page it is stuck on", async () => {
    const replies: string[] = [];
    for (let i = 0; i < 40; i++) replies.push("null", '"/en-US/login"');
    const { run } = scripted(replies);
    assert.equal(await pollPage(run, "probe", noPause), "still on /en-US/login after 20s");
  });

  it("passes a closed browser or any other failure on at once", async () => {
    const closed = new Error(
      "agent-browser eval exited 1: Target page, context or browser has been closed",
    );
    const first = scripted([closed, '"app"']);
    await assert.rejects(pollPage(first.run, "probe", noPause), /has been closed/);
    assert.equal(first.calls.length, 1);
    const { run } = scripted([new Error("agent-browser eval exited 1: daemon not running")]);
    await assert.rejects(pollPage(run, "probe", noPause), /daemon not running/);
  });

  it("reports the navigation error, not a page, when every attempt was cut off", async () => {
    const { run } = scripted(Array.from({ length: 40 }, navigated));
    await assert.rejects(pollPage(run, "probe", noPause), /Inspected target navigated/);
  });

  it("sends one short expression per poll, never over stdin", async () => {
    const { run, calls } = scripted(['"app"']);
    await pollPage(run, "probe()", noPause);
    assert.deepEqual(calls, [["eval", "probe()"]]);
  });
});

/**
 * A fake agent-browser for a whole sign-in: `answer` picks the reply to each
 * eval (an Error is thrown); every command and its stdin are recorded.
 */
function fakeBrowser(answer: (script: string) => string | Error = () => "true") {
  const commands: { args: string[]; input?: string }[] = [];
  const browser: CheckRun["browser"] = {
    async run(args, input) {
      commands.push({ args, input });
      if (args[0] !== "eval") return "";
      const reply = answer(input ?? args[1] ?? "");
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async evalJson<T>(): Promise<T> {
      throw new Error("not used");
    },
    close() {},
  };
  return { browser, commands };
}

/** A stack whose sign-in ends in a full page load: the first poll after the submit is cut off. */
function stack(options: { secondFactor?: boolean; landsOn?: string } = {}) {
  let submitted = false;
  let verified = false;
  let cutOff = false;
  return (script: string): string | Error => {
    if (script.includes("__reactProps")) return '"ready"';
    if (script.includes("requestSubmit")) {
      submitted = true;
      return "true";
    }
    if (script.includes("button.click()")) {
      verified = true;
      return '"clicked"';
    }
    if (script === "location.pathname") return JSON.stringify(options.landsOn ?? "/en-US/login");
    if (script.startsWith("location.pathname ===")) {
      if (!submitted || (options.secondFactor && !verified))
        return options.secondFactor && script.includes("totp-code") ? '"code"' : "null";
      if (!cutOff) {
        cutOff = true;
        return navigated();
      }
      return options.landsOn ? "null" : '"app"';
    }
    return "true";
  };
}

describe("formSignIn", () => {
  const base = "http://127.0.0.1:3001";
  const account = { email: "e2e-user@example.com", password: "correct horse battery" };

  it("signs in through the form and survives the page load the redirect ends in", async () => {
    const { browser, commands } = fakeBrowser(stack());
    await formSignIn({ base, browser, args: [] }, account, "/en-US/settings", noPause);
    assert.deepEqual(commands[0]?.args, [
      "open",
      `${base}/en-US/login?redirectTo=%2Fen-US%2Fsettings`,
    ]);
    // The consent is recorded last, on the app page.
    assert.match(commands.at(-1)?.args[1] ?? "", /knowledge-base\.consent\.v1/);
  });

  it("sends the password over stdin only", async () => {
    const { browser, commands } = fakeBrowser(stack());
    await formSignIn({ base, browser, args: [] }, account, "/en-US/settings", noPause);
    assert.ok(commands.some((command) => command.input?.includes(account.password)));
    for (const command of commands)
      assert.ok(!command.args.join(" ").includes(account.password), command.args.join(" "));
  });

  it("types a current code at the second-factor step and waits for the app", async () => {
    let asked = 0;
    const { browser, commands } = fakeBrowser(stack({ secondFactor: true }));
    await formSignIn(
      { base, browser, args: [] },
      {
        ...account,
        totp: () => {
          asked++;
          return "123456";
        },
      },
      "/en-US/settings",
      noPause,
    );
    assert.equal(asked, 1);
    assert.ok(commands.some((command) => command.input?.includes('"123456"')));
  });

  it("says what is wrong when the account has a second factor and no code", async () => {
    const { browser } = fakeBrowser(stack({ secondFactor: true }));
    await assert.rejects(
      formSignIn({ base, browser, args: [] }, account, "/en-US/settings", noPause),
      /has a second factor and no code source/,
    );
  });

  it("reports where a refused sign-in is stuck, never the password", async () => {
    const { browser } = fakeBrowser(stack({ landsOn: "/en-US/login" }));
    await assert.rejects(
      formSignIn({ base, browser, args: [] }, account, "/en-US/settings", noPause),
      (error: Error) =>
        /sign-in did not open the app \(still on \/en-US\/login after 20s\)/.test(error.message) &&
        !error.message.includes(account.password),
    );
  });
});

describe("totpCode", () => {
  it("matches RFC 6238's SHA-1 vectors (6 digits)", () => {
    assert.equal(totpCode("12345678901234567890", 59_000), "287082");
    assert.equal(totpCode("12345678901234567890", 1_111_111_109_000), "081804");
  });
});

describe("sessionName", () => {
  it("is one session per process, behind an optional prefix", () => {
    assert.equal(sessionName("check-layout", "", 42), "check-layout-42");
    assert.equal(sessionName("check-layout", "lane-d-", 42), "lane-d-check-layout-42");
    assert.match(sessionName("check-dialogs"), new RegExp(`check-dialogs-${process.pid}$`));
  });
});

describe("byRole", () => {
  it("groups the cases by role and keeps the listed order inside each", () => {
    const cases = [
      { name: "a", role: "user" },
      { name: "b", role: "admin" },
      { name: "c", role: "user" },
    ];
    assert.deepEqual(
      byRole(cases).map((item) => item.name),
      ["a", "c", "b"],
    );
  });
});

describe("signing in to a running stack", () => {
  const fixture = {
    user: { email: "e2e-user@example.com", password: "user-password-1234" },
    admin: {
      email: "e2e-admin@example.com",
      password: "admin-password-1234",
      // RFC 6238's SHA-1 seed "12345678901234567890", as the Base32 setup key 2FA setup shows.
      totpSecret: "GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ",
    },
  };
  const withFile = (content: string | undefined, body: (path: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "browser-checks-"));
    const path = join(dir, "accounts.json");
    if (content !== undefined) writeFileSync(path, content);
    try {
      body(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("says what to do when the accounts file is not usable", () => {
    assert.match(readFixture("").problem ?? "", /set BROWSER_CHECKS_ACCOUNTS/);
    withFile(undefined, (path) => {
      assert.match(readFixture(path).problem ?? "", /no accounts file at/);
    });
    withFile("[]", (path) => {
      assert.match(readFixture(path).problem ?? "", /is not an accounts object/);
    });
    withFile(JSON.stringify({ admin: fixture.admin }), (path) => {
      assert.throws(() => fixtureAccount("user", readFixture(path)), /no "user" account/);
      assert.equal(fixtureAccount("admin", readFixture(path)).email, fixture.admin.email);
    });
    assert.throws(
      () => fixtureAccount("user", { fixture: {}, problem: "set BROWSER_CHECKS_ACCOUNTS" }),
      /set BROWSER_CHECKS_ACCOUNTS/,
    );
  });

  it("names a malformed accounts file without echoing what is in it", () => {
    // An unquoted password: JSON.parse's message would quote the text around it.
    const secret = "hunter2-not-a-real-password";
    withFile(`{"user":{"password":${secret}}}`, (path) => {
      const message = readFixture(path).problem ?? "";
      assert.match(message, /is not valid JSON/);
      assert.ok(message.includes(path), "names the file");
      assert.ok(!message.includes("hunter2"), "never echoes the file's contents");
      assert.ok(!/Unexpected token|position/.test(message), "no JSON.parse detail");
    });
  });

  it("codes a second factor from the account's Base32 setup key", () => {
    assert.equal(base32Bytes("gezdgnbvgy3tqojq====").toString("utf8"), "1234567890");
    const admin = fixtureAccount("admin", { fixture });
    // The setup key decodes to the seed, so the code is the seed's.
    assert.equal(admin.totp?.(), totpCode("12345678901234567890"));
    // RFC 6238 Appendix B, SHA-1, T = 59 s: 94287082 (8 digits; this app uses 6).
    assert.equal(totpCode(base32Bytes(fixture.admin.totpSecret), 59_000), "287082");
    assert.equal(fixtureAccount("user", { fixture }).totp, undefined);
    // Empty, or a length no whole number of bytes encodes to: never an empty HMAC key.
    for (const key of ["", "====", " ", "A", "ABC", "ABCDEF", "ABCDEFGHA"])
      assert.throws(() => base32Bytes(key), /not a Base32 setup key/, JSON.stringify(key));
    assert.equal(base32Bytes("AB").length, 1);
    assert.throws(
      () =>
        fixtureAccount("admin", {
          fixture: { admin: { ...fixture.admin, totpSecret: "not-base32!" } },
        }),
      (error: Error) =>
        /not a Base32 setup key/.test(error.message) && !error.message.includes("not-base32"),
    );
  });

  it("signs in once per role through the form, signing the other role out first", async () => {
    const { browser, commands } = fakeBrowser(stack({ secondFactor: false }));
    const run = { base: "http://127.0.0.1:3001", browser, args: ["--url", "x"] };
    await signIn(run, "user", {}, { fixture });
    await signIn(run, "user", {}, { fixture });
    await signIn(run, "anonymous", {}, { fixture });
    const opens = commands.filter((command) => command.args[0] === "open");
    assert.equal(opens.length, 2);
    assert.match(opens[0]?.args[1] ?? "", /\/en-US\/login\?redirectTo=/);
    assert.equal(commands.filter((command) => command.args[1] === "clear").length, 2);
    assert.ok(
      commands.some((command) => command.input?.includes("user-password-1234")),
      "the user's password was typed",
    );
    for (const command of commands)
      assert.ok(!command.args.join(" ").includes("user-password-1234"), command.args.join(" "));
  });

  it("names what a dialog or page needs when the stack lacks it", () => {
    for (const item of [...DIALOGS, ...SHELL_PAGES])
      if (item.path.includes("/kbs/")) assert.match(item.needs ?? "", /kbId/, item.name);
  });
});
