import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { KbEditorSession } from "@/components/kb/document-editor";
import {
  DocumentMoveSheet,
  documentMoveAction,
  moveOutcomePlan,
  moveTargetError,
} from "@/components/kb/document-move-sheet";
import { describeEditorError, type EditorOutcome } from "@/hooks/use-kb-editor";

/** The sheet renders in a portal (nothing in static markup): render its parts inline. */
vi.mock("@knowledge-base/ui/components/sheet", () => {
  const pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Sheet: pass,
    SheetContent: pass,
    SheetHeader: pass,
    SheetFooter: pass,
    SheetTitle: pass,
    SheetDescription: pass,
  };
});

const HEAD = "1".repeat(40);
const NEW_HEAD = "2".repeat(40);
const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: "en-US",
    fallbackLng: "en-US",
    ns: ["kb", "common"],
    defaultNS: "kb",
    resources: { "en-US": { kb: enKb, common: enCommon } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
});

function editor(overrides: Partial<KbEditorSession> = {}): KbEditorSession {
  return {
    path: "notes/a.md",
    pending: false,
    paused: false,
    proposal: false,
    submit: async () => undefined,
    ...overrides,
  } as unknown as KbEditorSession;
}

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );
const t = (key: string) => i18n.t(key);

describe("rename or move: client-side path rules", () => {
  it("accepts a new .md path in any folder", () => {
    expect(moveTargetError("notes/a.md", "notes/b.md")).toBeNull();
    expect(moveTargetError("notes/a.md", "archive/2026/a.md")).toBeNull();
    expect(moveTargetError("notes/a.md", "a.md")).toBeNull();
  });

  it("names what is wrong with a target before anything is sent", () => {
    expect(moveTargetError("notes/a.md", "")).toBe("empty");
    expect(moveTargetError("notes/a.md", "notes/a.txt")).toBe("notMarkdown");
    expect(moveTargetError("notes/a.md", "notes/a")).toBe("notMarkdown");
    expect(moveTargetError("notes/a.md", ".assets/a.md")).toBe("reserved");
    expect(moveTargetError("notes/a.md", "/notes/b.md")).toBe("invalid");
    expect(moveTargetError("notes/a.md", "notes//b.md")).toBe("invalid");
    expect(moveTargetError("notes/a.md", "../b.md")).toBe("invalid");
    expect(moveTargetError("notes/a.md", "notes\\b.md")).toBe("invalid");
    expect(moveTargetError("notes/a.md", "notes/a.md")).toBe("same");
    // Every refusal has its own message.
    for (const error of ["empty", "notMarkdown", "reserved", "invalid", "same"])
      expect(t(`kb:move.error.${error}`)).not.toBe(`move.error.${error}`);
  });
});

describe("rename or move: what an outcome does to the sheet", () => {
  it("a taken path is shown under the field", () => {
    const outcome = describeEditorError(
      Object.assign(new Error("CONFLICT"), {
        code: "CONFLICT",
        data: { code: "CONFLICT", details: { reason: "PATH_EXISTS" } },
      }),
    );
    expect(moveOutcomePlan(outcome, "notes/a.md")).toEqual({ kind: "field", error: "exists" });
    expect(t("kb:move.error.exists")).toBe(
      "A document already exists at this path. Choose another path.",
    );
  });

  it("relative image links that a folder change would break are explained under the field", () => {
    const outcome: EditorOutcome = {
      kind: "error",
      reason: "rejected",
      path: "MOVE_BREAKS_ASSET_LINKS",
    };
    expect(moveOutcomePlan(outcome, "notes/a.md")).toEqual({
      kind: "field",
      error: "relativeLinks",
    });
    expect(t("kb:move.error.relativeLinks")).toContain("start with /");
  });

  it("a receipt closes the sheet (the session's new path navigates the page)", () => {
    expect(
      moveOutcomePlan({ kind: "applied", commitSha: NEW_HEAD, indexJobId: null }, "notes/a.md"),
    ).toEqual({ kind: "done", proposal: null });
    expect(
      moveOutcomePlan(
        { kind: "proposed", proposalNumber: 3, proposalHead: NEW_HEAD, created: true },
        "notes/a.md",
      ),
    ).toEqual({ kind: "done", proposal: { number: 3, created: true } });
  });

  it("a moved head is asked about again; an unknown outcome keeps the sheet open", () => {
    expect(
      moveOutcomePlan({ kind: "conflict", headSha: HEAD, proposalNumber: null }, "notes/a.md"),
    ).toEqual({ kind: "stale", stale: { headSha: HEAD, proposalNumber: null } });
    expect(moveOutcomePlan({ kind: "retryable" }, "notes/a.md")).toEqual({
      kind: "notice",
      outcome: { kind: "retryable" },
    });
  });
});

describe("rename or move sheet", () => {
  it("is a More actions entry, unavailable while a save is in flight", () => {
    const t = (key: string) => i18n.t(key);
    let opened = false;
    const action = documentMoveAction(t, false, () => {
      opened = true;
    });
    expect(action).toMatchObject({ key: "move", label: "Rename or move", testId: "document-move" });
    expect(action.disabled).toBe(false);
    action.onSelect();
    expect(opened).toBe(true);
    expect(documentMoveAction(t, true, () => {}).disabled).toBe(true);
  });

  it("prefills the current path in one field with autocomplete off and explains the Git rename", () => {
    const html = render(
      <DocumentMoveSheet editor={editor()} proposing={false} onOpenChange={() => {}} />,
    );
    expect(html).toContain("Rename or move document");
    expect(html).toContain('value="notes/a.md"');
    expect(html).toContain('autoComplete="off"');
    expect(html).toContain('inputMode="text"');
    expect(html).toContain(t("kb:move.hint"));
    expect(html).toContain("New path");
    expect(html).toContain("Move document");
  });

  it("says a propose-only move goes to the pull request, and shows the offline notice", () => {
    const html = render(
      <DocumentMoveSheet editor={editor({ paused: true })} proposing onOpenChange={() => {}} />,
    );
    expect(html).toContain(t("kb:move.hintProposal"));
    expect(html).toContain("You&#x27;re offline. The change will be sent when you reconnect.");
  });
});
