import { smtpFromSchema } from "@knowledge-base/env/mailbox";
import { describe, expect, it } from "vitest";

import { senderHeader } from "./sender";

describe("senderHeader", () => {
  it("names a bare SMTP_FROM address after the app", () => {
    const header = senderHeader("no-reply@kb.example", "KnowledgeBase");
    expect(header).toBe('"KnowledgeBase" <no-reply@kb.example>');
    expect(smtpFromSchema.safeParse(header).success).toBe(true);
  });

  it("keeps a display name the operator already chose", () => {
    expect(senderHeader('"Acme Docs" <docs@acme.example>', "KnowledgeBase")).toBe(
      '"Acme Docs" <docs@acme.example>',
    );
    expect(senderHeader("Acme Docs <docs@acme.example>", "KnowledgeBase")).toBe(
      "Acme Docs <docs@acme.example>",
    );
  });

  it("escapes quotes in an overridden app name", () => {
    const header = senderHeader("a@kb.example", 'Say "hi"');
    expect(header).toBe('"Say \\"hi\\"" <a@kb.example>');
    expect(smtpFromSchema.safeParse(header).success).toBe(true);
  });
});
