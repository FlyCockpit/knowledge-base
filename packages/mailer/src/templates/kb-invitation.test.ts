import { describe, expect, it } from "vitest";

import { renderKbShareInvite, renderKbTransferOffer } from "./kb-invitation";

const share = {
  inviterName: "Ada",
  kbName: "Team notes",
  acceptUrl: "https://kb.example.com/en-US/kbs/abc/settings?accept=1111",
  signupUrl:
    "https://kb.example.com/en-US/signup?redirectTo=%2Fen-US%2Fkbs%2Fabc%2Fsettings%3Faccept%3D1111",
};

describe("renderKbShareInvite", () => {
  it("renders the acceptance link, the sign-up path and the copyable fallback in en-US", () => {
    const { subject, html } = renderKbShareInvite({ ...share, locale: "en-US" });
    expect(subject).toBe("You've been invited to a knowledge base");
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain("Ada");
    expect(html).toContain("Team notes");
    expect(html).toContain(`href="${share.acceptUrl}"`);
    expect(html).toContain(`href="${share.signupUrl}"`);
    expect(html).toContain("Accept invitation");
    expect(html).toContain("Create an account");
    // The link is also shown as copyable text.
    expect(html.split(share.acceptUrl).length).toBeGreaterThanOrEqual(3);
  });

  it("renders es-MX without en-US literals and falls back to en-US for unknown locales", () => {
    const es = renderKbShareInvite({ ...share, locale: "es-MX" });
    expect(es.html).toContain('<html lang="es-MX">');
    expect(es.html).toContain("Aceptar invitación");
    expect(es.html).not.toContain(">Accept invitation<");
    const fallback = renderKbShareInvite({ ...share, locale: "fr-FR" });
    expect(fallback.html).toContain('<html lang="en-US">');
  });

  it("escapes names and refuses non-HTTP links", () => {
    const { html } = renderKbShareInvite({
      ...share,
      inviterName: '<script>alert("x")</script>',
      kbName: "</p><img src=x>",
      locale: "en-US",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x>");
    expect(() =>
      renderKbShareInvite({ ...share, acceptUrl: "javascript:alert(1)", locale: "en-US" }),
    ).toThrow();
  });
});

describe("renderKbTransferOffer", () => {
  it("renders the transfer link with no sign-up section", () => {
    const acceptUrl = "https://kb.example.com/es-MX/kbs/abc/settings?transfer=2222";
    const { subject, html } = renderKbTransferOffer({
      inviterName: "Ada",
      kbName: "Team notes",
      acceptUrl,
      locale: "es-MX",
    });
    expect(subject).toBe("Te ofrecieron la propiedad de una base de conocimiento");
    expect(html).toContain(`href="${acceptUrl}"`);
    expect(html).not.toContain("signup");
  });
});
