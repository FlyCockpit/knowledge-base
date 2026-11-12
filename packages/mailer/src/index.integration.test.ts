import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { sharedVars } from "@knowledge-base/env/vars/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: 0,
  SMTP_FROM: "App <one@example.invalid>",
  SMTP_USER: undefined,
  SMTP_PASS: undefined,
}));
vi.mock("@knowledge-base/env/shared", () => ({ env: config }));

import { type AuthorizeEmailSend, sendEmail } from "./index";

const sockets = new Set<Socket>();
let messages: string[];
let commands: string[];
let stall: boolean;
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
        if (line.startsWith("EHLO") || line.startsWith("HELO")) socket.write("250 localhost\r\n");
        else if (line === "DATA") {
          data = [];
          socket.write("354 send data\r\n");
        } else if (line === "QUIT") {
          socket.end("221 bye\r\n");
        } else if (!stall || !line.startsWith("RCPT")) socket.write("250 OK\r\n");
      }
    }
  });
});
beforeEach(async () => {
  messages = [];
  commands = [];
  stall = false;
  config.SMTP_FROM = "App <one@example.invalid>";
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing SMTP listener");
  config.SMTP_PORT = address.port;
});
afterEach(async () => {
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
