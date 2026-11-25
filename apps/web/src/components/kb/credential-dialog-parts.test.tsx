import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AdvancedSection, CreateFooter } from "@/components/kb/credential-dialog-parts";
import { RadioCards } from "@/components/kb/radio-cards";

vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const footer = (props: Partial<React.ComponentProps<typeof CreateFooter>>) =>
  renderToStaticMarkup(
    <CreateFooter
      reasons={[]}
      pending={false}
      blocked={false}
      submitLabel="Create token"
      pendingLabel="Creating…"
      onCancel={() => undefined}
      {...props}
    />,
  );

describe("CreateFooter", () => {
  it("names the first reason Create is disabled, next to it and describing it", () => {
    const html = footer({ reasons: ["Choose what the token should do.", "Choose a write mode."] });
    expect(html).toContain("Choose what the token should do.");
    expect(html).not.toContain("Choose a write mode.");
    const reasonId = /<p id="([^"]+)" role="status"/.exec(html)?.[1];
    expect(reasonId).toBeTruthy();
    expect(html).toMatch(
      new RegExp(`<button type="submit"[^>]* disabled=""[^>]*aria-describedby="${reasonId}"`),
    );
    // The footer stays in view while the form scrolls.
    expect(html).toContain("sticky -bottom-4");
  });

  it("enables Create with no reason, and shows no reason while creating", () => {
    const ready = footer({});
    expect(ready).not.toContain('role="status"');
    expect(ready).not.toMatch(/<button type="submit"[^>]* disabled=""/);
    const pending = footer({ pending: true, reasons: ["x"] });
    expect(pending).toContain("Creating…");
    expect(pending).not.toContain('role="status"');
    expect(footer({ blocked: true })).toMatch(/<button type="submit"[^>]* disabled=""/);
  });
});

describe("AdvancedSection", () => {
  it("starts closed unless asked to start open", () => {
    const closed = renderToStaticMarkup(<AdvancedSection label="Advanced">body</AdvancedSection>);
    expect(closed).toContain('aria-expanded="false"');
    // A long translated label wraps instead of running past a phone-width dialog.
    expect(closed).toMatch(/aria-expanded="false"[^>]*class="[^"]*whitespace-normal[^"]*"/);
    expect(closed).not.toContain("body");
    const open = renderToStaticMarkup(
      <AdvancedSection label="Advanced" defaultOpen>
        body
      </AdvancedSection>,
    );
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("body");
  });
});

describe("RadioCards", () => {
  it("preselects nothing until a value is chosen", () => {
    const options = [
      { value: "read", label: "Read", description: "Only reads." },
      { value: "direct", label: "Direct edits", description: "Edits." },
    ] as const;
    const none = renderToStaticMarkup(
      <RadioCards legend="What?" options={options} value={null} onChange={() => undefined} />,
    );
    expect(none).not.toContain('checked=""');
    const chosen = renderToStaticMarkup(
      <RadioCards legend="What?" options={options} value="direct" onChange={() => undefined} />,
    );
    expect(chosen.match(/checked=""/g)).toHaveLength(1);
    expect(chosen).toMatch(/checked="" value="direct"/);
    // The accessible name is the title alone ("Read"), the description stays a description.
    const id = /<input id="([^"]+-read)"/.exec(none)?.[1];
    expect(none).toContain(`aria-labelledby="${id}-label"`);
    expect(none).toContain(
      `<span id="${id}-label" class="block text-sm leading-snug font-medium">Read</span>`,
    );
    expect(none).toContain(`aria-describedby="${id}-desc"`);
  });
});
