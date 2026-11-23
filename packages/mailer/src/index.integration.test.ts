import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { sharedVars } from "@knowledge-base/env/vars/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: 0,
  SMTP_FROM: "App <one@example.invalid>",
  SMTP_USER: undefined as string | undefined,
  SMTP_PASS: undefined as { reveal(): string } | undefined,
}));
vi.mock("@knowledge-base/env/shared", () => ({ env: config }));

import { type AuthorizeEmailSend, sendEmail, verifyTransport } from "./index";

const sockets = new Set<Socket>();
let messages: string[];
let commands: string[];
let stall: boolean;
/** After RCPT, trickle continuation lines that never complete the reply. */
let drip: boolean;
/** Advertise and accept AUTH PLAIN; otherwise AUTH is not offered and is refused. */
let offerAuth: boolean;
/** Trickle the EHLO reply so setup never completes. */
let dripEhlo: boolean;
const drips = new Set<ReturnType<typeof setInterval>>();
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.on("close", () => sockets.delete(socket));
  socket.write("220 local SMTP\r\n");
  let pending = "";
  let data: string[] | null = null;
  socket.on("data", (bytes) => {
    pending += bytes.toString("latin1");
    for (;;) {
      const end = pending.indexOf("\n");
      if (end < 0) break;
      const line = pending.slice(0, end).replace(/\r$/, "");
      pending = pending.slice(end + 1);
      if (data) {
        if (line === ".") {
          messages.push(data.join("\r\n"));
          data = null;
          socket.write("250 accepted\r\n");
        } else data.push(line);
      } else {
        commands.push(line);
        if (dripEhlo && line.startsWith("EHLO")) {
          const timer = setInterval(() => socket.write("250-still greeting\r\n"), 1_000);
          drips.add(timer);
          socket.on("close", () => {
            clearInterval(timer);
            drips.delete(timer);
          });
        } else if (line.startsWith("EHLO") || line.startsWith("HELO"))
          socket.write(offerAuth ? "250-localhost\r\n250 AUTH PLAIN\r\n" : "250 localhost\r\n");
        else if (line.startsWith("AUTH"))
          socket.write(offerAuth ? "235 accepted\r\n" : "502 not supported\r\n");
        else if (line === "DATA") {
          data = [];
          socket.write("354 send data\r\n");
        } else if (line === "QUIT") {
          socket.end("221 bye\r\n");
        } else if (drip && line.startsWith("RCPT")) {
          const timer = setInterval(() => socket.write("250-still checking\r\n"), 1_000);
          drips.add(timer);
          socket.on("close", () => {
            clearInterval(timer);
            drips.delete(timer);
          });
        } else if (!stall || !line.startsWith("RCPT")) socket.write("250 OK\r\n");
      }
    }
  });
});
beforeEach(async () => {
  messages = [];
  commands = [];
  stall = false;
  drip = false;
  offerAuth = false;
  dripEhlo = false;
  config.SMTP_USER = undefined;
  config.SMTP_PASS = undefined;
  config.SMTP_FROM = "App <one@example.invalid>";
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing SMTP listener");
  config.SMTP_PORT = address.port;
});
afterEach(async () => {
  for (const timer of drips) clearInterval(timer);
  drips.clear();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  sockets.clear();
});
const allowed: AuthorizeEmailSend = (send) => send(new AbortController().signal);
const message = {
  to: "recipient@example.invalid",
  subject: "Invitation",
  html: "<p>Private KB</p>",
};

describe("production SMTP serialization and authorized transport", () => {
  it("exact mailbox bounds produce one envelope recipient and SMTP lines below 998 octets", async () => {
    const to = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    await sendEmail({ ...message, to, authorizeSend: allowed });
    expect(messages).toHaveLength(1);
    expect(commands.filter((line) => line.startsWith("RCPT"))).toEqual([`RCPT TO:<${to}>`]);
    expect(messages[0]!.replace(/\r\n[ \t]+/g, " ")).toContain(`To: ${to}`);
    expect(
      Math.max(...messages[0]!.split("\r\n").map((line) => Buffer.byteLength(line, "latin1"))),
    ).toBeLessThanOrEqual(998);
    await expect(
      sendEmail({ ...message, to: `${"a".repeat(1100)}@example.invalid`, authorizeSend: allowed }),
    ).rejects.toThrow();
    expect(messages).toHaveLength(1);
  });
  it("single From round trips; multi-mailbox config is rejected before any SMTP effect", async () => {
    config.SMTP_FROM = '"Doe, Jane" <one@example.invalid>';
    expect(sharedVars.SMTP_FROM.parse(config.SMTP_FROM)).toBe(config.SMTP_FROM);
    await sendEmail({ ...message, authorizeSend: allowed });
    expect(messages[0]).toContain('From: "Doe, Jane" <one@example.invalid>');
    expect(commands).toContain("MAIL FROM:<one@example.invalid>");
    config.SMTP_FROM = "one@example.invalid, two@example.invalid";
    expect(sharedVars.SMTP_FROM.safeParse(config.SMTP_FROM).success).toBe(false);
    await expect(sendEmail(message)).rejects.toThrow();
    expect(messages).toHaveLength(1);
  });
  it("quoted specials and Unicode display names round trip through an independent MIME parser", async () => {
    for (const [from, name] of [
      [String.raw`"Quote\" and slash\\" <one@example.invalid>`, 'Quote" and slash\\'],
      ['"Zoë, Jane" <one@example.invalid>', "Zoë, Jane"],
      // A bare address is sent under the app's name.
      ["one@example.invalid", process.env.VITE_APP_NAME || "KnowledgeBase"],
    ]) {
      config.SMTP_FROM = from!;
      await sendEmail({ ...message, authorizeSend: allowed });
      const wire = messages.at(-1)!;
      const parsed = JSON.parse(
        execFileSync(
          "python3",
          [
            "-c",
            "import sys,json; from email import policy; from email.parser import BytesParser; m=BytesParser(policy=policy.default).parsebytes(sys.stdin.buffer.read()); a=m['From'].addresses; print(json.dumps([[x.display_name,x.addr_spec] for x in a]))",
          ],
          { input: wire, encoding: "utf8" },
        ),
      );
      expect(parsed).toEqual([[name, "one@example.invalid"]]);
      expect(
        Math.max(...wire.split("\r\n").map((line) => Buffer.byteLength(line, "latin1"))),
      ).toBeLessThanOrEqual(998);
    }
  });
  it("denied handoff never issues MAIL/RCPT/DATA and closes each prepared connection", async () => {
    let checked = 0;
    await expect(
      sendEmail({
        ...message,
        authorizeSend: async () => {
          checked++;
          throw new Error("revoked");
        },
      }),
    ).rejects.toThrow("revoked");
    expect(checked).toBe(3);
    expect(commands.every((line) => line.startsWith("EHLO"))).toBe(true);
    expect(messages).toEqual([]);
    await expect.poll(() => sockets.size).toBe(0);
  });
  it("authenticates only when the relay offers AUTH, as nodemailer's transport did", async () => {
    config.SMTP_USER = "relay-user";
    config.SMTP_PASS = { reveal: () => "relay-pass" };
    await sendEmail(message);
    expect(messages).toHaveLength(1);
    expect(commands.some((line) => line.startsWith("AUTH"))).toBe(false);
    expect(await verifyTransport()).toBe(true);
    offerAuth = true;
    commands = [];
    await sendEmail(message);
    expect(messages).toHaveLength(2);
    expect(commands.filter((line) => line.startsWith("AUTH PLAIN"))).toHaveLength(1);
  });
  it("the in-request verifyTransport preflight is bounded by the setup deadline", async () => {
    expect(await verifyTransport()).toBe(true);
    expect(commands.some((line) => line.startsWith("MAIL"))).toBe(false);
    dripEhlo = true;
    const started = Date.now();
    expect(await verifyTransport()).toBe(false);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(9_000);
    expect(elapsed).toBeLessThan(20_000);
    await expect.poll(() => sockets.size).toBe(0);
  }, 40_000);
  it("an in-request send to a relay that trickles bytes fails within an absolute bound", async () => {
    // The relay never goes silent for the 5 s inactivity timeout, so only the
    // absolute send deadline ends each attempt; the request stays inside the 100 s proxy budget.
    drip = true;
    const started = Date.now();
    await expect(sendEmail(message)).rejects.toThrow("SMTP send cancelled");
    const elapsed = Date.now() - started;
    expect(commands.filter((line) => line.startsWith("RCPT"))).toHaveLength(3);
    expect(elapsed).toBeGreaterThanOrEqual(30_000);
    expect(elapsed).toBeLessThan(60_000);
    expect(messages).toEqual([]);
    await expect.poll(() => sockets.size).toBe(0);
    drip = false;
    await sendEmail(message);
    expect(messages).toHaveLength(1);
  }, 90_000);
  it("abort of stalled SMTP drains sockets before guarded send returns; subsequent delivery succeeds", async () => {
    stall = true;
    await expect(
      sendEmail({
        ...message,
        authorizeSend: async (send) => {
          const abort = new AbortController();
          const timer = setTimeout(() => abort.abort(), 25);
          try {
            await send(abort.signal);
          } finally {
            clearTimeout(timer);
          }
        },
      }),
    ).rejects.toThrow("SMTP send cancelled");
    expect(messages).toEqual([]);
    await expect.poll(() => sockets.size).toBe(0);
    stall = false;
    await sendEmail({ ...message, authorizeSend: allowed });
    expect(messages).toHaveLength(1);
  });
});
