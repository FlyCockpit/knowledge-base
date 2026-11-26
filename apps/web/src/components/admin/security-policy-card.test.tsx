import enAdmin from "@knowledge-base/locales/src/en-US/admin.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ lang: "es-MX" }),
  Link: ({
    to,
    params,
    className,
    children,
  }: {
    to: string;
    params: { lang: string };
    className?: string;
    children: ReactNode;
  }) => (
    <a data-to={to} data-lang={params.lang} className={className}>
      {children}
    </a>
  ),
}));

const { SecurityPolicyCard } = await import("./security-policy-card");

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    resources: { "en-US": { admin: enAdmin } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

const policies = [
  { key: "force2faInternalUsers" as const, enabled: true, title: "Admins", description: "A" },
  { key: "force2faPublicUsers" as const, enabled: false, title: "Public", description: "B" },
];

function render(adminHas2FA: boolean, isUpdating = false) {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <SecurityPolicyCard
        policies={policies}
        adminHas2FA={adminHas2FA}
        isUpdating={isUpdating}
        onToggle={vi.fn()}
      />
    </I18nextProvider>,
  );
}

// Attribute checks run on markup without class lists (the Switch's classes
// mention data-disabled / destructive as variants).
const attrs = (html: string) => html.replace(/ class="[^"]*"/g, "");

const rows = (html: string) =>
  [
    ...html.matchAll(
      /data-slot="settings-policy" data-state="(on|off)"([\s\S]*?)(?=data-slot="settings-policy"|$)/g,
    ),
  ].map(([, state = "", body = ""]) => ({ state, body }));

describe("SecurityPolicyCard", () => {
  it("shows each policy's state as a labelled switch with visible On/Off text", () => {
    const html = render(true);
    const [admins, publicUsers] = rows(attrs(html));
    expect(admins?.state).toBe("on");
    expect(admins?.body).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(admins?.body).toContain(">On<");
    expect(publicUsers?.state).toBe("off");
    expect(publicUsers?.body).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(publicUsers?.body).toContain(">Off<");
    // Named by the policy title, not by the On/Off text.
    const titleId = /<p id="([^"]+)">Admins<\/p>/.exec(attrs(html))?.[1];
    expect(titleId).toBeDefined();
    expect(html).toContain(`aria-labelledby="${titleId}"`);
    // No destructive "Disable" button carrying the state any more.
    expect(html).not.toMatch(/>Disable<|>Enable<|text-destructive|bg-destructive/);
    expect(html).not.toContain("settings-prerequisite");
  });

  it("shows the missing own-2FA prerequisite as an info note with a link, not an error", () => {
    const html = render(false);
    const note =
      /<div role="note" data-slot="settings-prerequisite" class="([^"]*)"[\s\S]*?<\/a>/.exec(html);
    expect(note).not.toBeNull();
    expect(note?.[1]).toContain("bg-state-info-bg");
    expect(note?.[1]).not.toContain("destructive");
    expect(note?.[0]).toContain(
      `<p class="flex-1">${enAdmin.settings.force2faAdminPrerequisite}</p>`,
    );
    expect(note?.[0]).toContain(enAdmin.settings.force2faAdminPrerequisite);
    expect(note?.[0]).toMatch(
      new RegExp(
        `<a data-to="/\\$lang/settings/security" data-lang="es-MX"[^>]*>${enAdmin.settings.goToSecurity}</a>`,
      ),
    );
  });

  it("disables only the switch the prerequisite blocks and gives the reason beside it", () => {
    const [admins, publicUsers] = rows(attrs(render(false)));
    // Turning an ON policy off never needs the admin's own 2FA.
    expect(admins?.body).not.toMatch(/role="switch"[^>]*data-disabled/);
    expect(admins?.body).not.toContain(enAdmin.settings.force2faNeedsOwn2fa);
    expect(publicUsers?.body).toMatch(
      /role="switch"[^>]*aria-disabled="true"|role="switch"[^>]*data-disabled/,
    );
    const reasonId = new RegExp(
      `<p id="([^"]+)"[^>]*>${enAdmin.settings.force2faNeedsOwn2fa}</p>`,
    ).exec(publicUsers?.body ?? "")?.[1];
    expect(reasonId).toBeDefined();
    expect(publicUsers?.body).toMatch(new RegExp(`aria-describedby="[^"]*${reasonId}"`));
  });

  it("says it is updating while a change is in flight", () => {
    const html = render(true, true);
    expect(html).toContain(enAdmin.settings.updating);
  });
});
