import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, className, children }: { to: string; className?: string; children: ReactNode }) => (
    <a data-to={to} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("@knowledge-base/ui/components/sileo", () => ({ toast: { message: vi.fn() } }));

const { GettingStarted } = await import("./getting-started");
type Step = Parameters<typeof GettingStarted>[0]["steps"][number];

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    defaultNS: "common",
    resources: { "en-US": { common: enCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});
afterEach(() => vi.unstubAllGlobals());

const steps: Step[] = [
  {
    id: "create-kb",
    title: "Create a knowledge base",
    description: "A place for Markdown documents.",
    done: true,
    action: { label: "New knowledge base", onClick: () => {} },
  },
  {
    id: "connect-client",
    title: "Connect an AI client",
    description: "Let an MCP client search your knowledge bases.",
    done: false,
    action: {
      label: "Connect a client",
      link: { to: "/$lang/settings/mcp", params: { lang: "en-US" } },
    },
  },
];

/** Render with a fake browser: `wide` is whether `(min-width: 40rem)` matches. */
function render(list: Step[], { wide = true, hidden = false } = {}) {
  const storage = new Map<string, string>(
    hidden ? [["knowledge-base.getting-started.hidden.u1", "1"]] : [],
  );
  vi.stubGlobal("window", {
    matchMedia: () => ({ matches: wide }),
    localStorage: { getItem: (key: string) => storage.get(key) ?? null },
    addEventListener: () => {},
    removeEventListener: () => {},
  });
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <GettingStarted steps={list} scope="u1" />
    </I18nextProvider>,
  );
}

describe("GettingStarted", () => {
  it("shows the progress as 'n of m done'", () => {
    expect(render(steps)).toContain(">1 of 2 done<");
  });

  it("marks done steps from their data and shows the next action only for open ones", () => {
    const html = render(steps);
    expect(html).toMatch(/data-step="create-kb" data-done=""/);
    expect(html).toMatch(/data-step="connect-client" class=/);
    expect(html).toContain("(Done)");
    expect(html).toContain("(To do)");
    // The open step's action is a link to where it gets done.
    expect(html).toContain('data-to="/$lang/settings/mcp"');
    expect(html).toContain(">Connect a client<");
    // The done step offers no action any more.
    expect(html).not.toContain(">New knowledge base<");
  });

  it("renders nothing once every step is done", () => {
    expect(render(steps.map((step) => ({ ...step, done: true })))).toBe("");
  });

  it("renders nothing for a user who hid it", () => {
    expect(render(steps, { hidden: true })).toBe("");
  });

  it("is a disclosure, expanded from sm up", () => {
    const html = render(steps, { wide: true });
    const button = html.match(
      /<button type="button" aria-expanded="([^"]*)" aria-controls="([^"]*)"/,
    );
    expect(button?.[1]).toBe("true");
    expect(html).toContain(`<ol id="${button?.[2]}" class=`);
    expect(html).not.toMatch(/<ol [^>]*hidden/);
  });

  it("is collapsed below sm, keeping the title and the progress visible", () => {
    const html = render(steps, { wide: false });
    expect(html).toMatch(/aria-expanded="false"/);
    expect(html).toMatch(/<ol [^>]*hidden=""/);
    expect(html).toContain(">Get started<");
    expect(html).toContain(">1 of 2 done<");
  });

  it("offers Hide with a name that starts with its visible text", () => {
    const html = render(steps);
    expect(html).toMatch(/aria-label="Hide the getting-started checklist"[^>]*>Hide</);
  });

  it("keeps every control a 44px touch target", () => {
    const html = render(steps);
    const hide = html.match(/<button[^>]*aria-label="Hide the getting-started checklist"[^>]*>/);
    expect(hide?.[0]).toMatch(/class="[^"]*\bh-11\b/);
    const action = html.match(/<a data-to="\/\$lang\/settings\/mcp"[^>]*>/);
    expect(action?.[0]).toMatch(/class="[^"]*\bh-11\b/);
    expect(html).toMatch(/<button type="button" aria-expanded="[^"]*"[^>]*class="[^"]*min-h-11/);
  });
});
