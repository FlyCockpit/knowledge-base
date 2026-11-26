import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  CreateActions,
  FIRST_PROBLEM_SELECTOR,
  FormIssue,
  focusFirstProblem,
  scrollPageToTop,
} from "@/components/kb/credential-form-parts";
import { RadioCards } from "@/components/kb/radio-cards";

vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

const actions = (props: Partial<React.ComponentProps<typeof CreateActions>>) =>
  renderToStaticMarkup(
    <CreateActions
      reasons={[]}
      summary="Read · Engineering · Expires in 90 days"
      pending={false}
      blocked={false}
      submitLabel="Create token"
      pendingLabel="Creating…"
      cancelTo="/$lang/settings/mcp"
      lang="en-US"
      {...props}
    />,
  );

describe("CreateActions", () => {
  it("names the first thing still missing beside Create, which stays pressable", () => {
    const html = actions({ reasons: ["Choose a write mode.", "Choose a tool group."] });
    expect(html).toContain("Choose a write mode.");
    expect(html).not.toContain("Choose a tool group.");
    expect(html).not.toContain("Expires in 90 days");
    const noteId = /<p id="([^"]+)" role="status"/.exec(html)?.[1];
    expect(noteId).toBeTruthy();
    // Pressing it shows every problem next to its field, so it is not disabled.
    expect(html).toMatch(new RegExp(`<button type="submit"[^>]*aria-describedby="${noteId}"`));
    expect(html).not.toMatch(/<button type="submit"[^>]* disabled=""/);
  });

  it("says what Create will make once nothing is missing, and Cancel goes back to the list", () => {
    const ready = actions({});
    expect(ready).toContain("Read · Engineering · Expires in 90 days");
    expect(ready).toContain('href="/$lang/settings/mcp"');
    expect(ready).toContain("actions.cancel");
  });

  it("disables Create only while creating or after an uncertain attempt", () => {
    const pending = actions({ pending: true, reasons: ["x"] });
    expect(pending).toContain("Creating…");
    expect(pending).not.toContain('role="status"');
    expect(pending).toMatch(/<button type="submit"[^>]* disabled=""/);
    expect(actions({ blocked: true })).toMatch(/<button type="submit"[^>]* disabled=""/);
  });

  it("shows a failed attempt's alert beside Create instead of the note, and Create points at it", () => {
    const html = actions({
      alert: "Offline: nothing was sent.",
      reasons: ["Choose a write mode."],
    });
    expect(html).toContain("Offline: nothing was sent.");
    expect(html).not.toContain("Choose a write mode.");
    expect(html).not.toContain('role="status"');
    const alertId = /<p id="([^"]+)" role="alert"/.exec(html)?.[1];
    expect(alertId).toBeTruthy();
    expect(html).toMatch(new RegExp(`<button type="submit"[^>]*aria-describedby="${alertId}"`));
  });
});

describe("FormIssue and focusFirstProblem", () => {
  it("renders nothing without a message, and a focusable alert with one", () => {
    expect(renderToStaticMarkup(<FormIssue message={undefined} />)).toBe("");
    expect(renderToStaticMarkup(<FormIssue message="Choose a write mode." />)).toBe(
      '<p data-form-issue="true" tabindex="-1" role="alert" class="text-sm text-destructive">Choose a write mode.</p>',
    );
  });

  it("focuses the first invalid field or problem, opening the closed sections around it", () => {
    const focus = vi.fn();
    const scrollIntoView = vi.fn();
    const outer = { open: false, parentElement: null as unknown };
    const inner = { open: false, parentElement: { closest: () => outer } };
    const target = { focus, scrollIntoView, closest: () => inner };
    const querySelector = vi.fn(() => target);
    focusFirstProblem({ querySelector } as unknown as ParentNode, (run) => run());
    expect(querySelector).toHaveBeenCalledWith(FIRST_PROBLEM_SELECTOR);
    expect(FIRST_PROBLEM_SELECTOR).toContain('[aria-invalid="true"]');
    expect(FIRST_PROBLEM_SELECTOR).toContain("[data-form-issue]");
    expect(inner.open).toBe(true);
    expect(outer.open).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("does nothing without a form or a problem", () => {
    expect(() => focusFirstProblem(null, (run) => run())).not.toThrow();
    const querySelector = vi.fn(() => null);
    focusFirstProblem({ querySelector } as unknown as ParentNode, (run) => run());
    expect(querySelector).toHaveBeenCalled();
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

describe("scrollPageToTop", () => {
  it("brings the app's page scroller to the top", () => {
    const scrollTo = vi.fn();
    const querySelector = vi.fn(() => ({ scrollTo }));
    scrollPageToTop({ querySelector } as unknown as ParentNode);
    expect(querySelector).toHaveBeenCalledWith('[data-scroll-restoration-id="app-main"]');
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
  });
});
