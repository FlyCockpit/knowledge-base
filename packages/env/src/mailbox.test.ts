import { describe, expect, it } from "vitest";
import { mailboxSchema, smtpFromSchema } from "./mailbox";
import { sharedVars } from "./vars/shared";

describe("SMTP mailbox bounds", () => {
  it("accepts exactly 64 local octets, 63 domain-label octets and 254 total octets", () => {
    const exact = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(exact.length).toBe(254);
    expect(mailboxSchema.parse(exact)).toBe(exact);
    for (const address of [
      exact + "a",
      `${"a".repeat(65)}@example.com`,
      `a@${"b".repeat(64)}.com`,
      "a@example.com\r\nBcc: x@example.com",
    ])
      expect(mailboxSchema.safeParse(address).success).toBe(false);
  });
  it("SMTP_FROM accepts one bare/named mailbox and rejects lists, groups and controls", () => {
    for (const from of [
      "one@example.com",
      "App Name <one@example.com>",
      '"Doe, Jane" <one@example.com>',
      String.raw`"Quote\" and slash\\" <one@example.com>`,
      "Zoë <one@example.com>",
    ])
      expect(sharedVars.SMTP_FROM.parse(from)).toBe(from);
    for (const from of [
      "one@example.com, two@example.com",
      "Group: one@example.com;",
      "Doe, Jane <one@example.com>",
      "App\nName <one@example.com>",
      `App <${"a".repeat(65)}@example.com>`,
    ])
      expect(smtpFromSchema.safeParse(from).success).toBe(false);
    expect(sharedVars.SMTP_FROM.safeParse(undefined).success).toBe(true);
  });
});
