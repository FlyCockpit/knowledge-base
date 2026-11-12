import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import esKb from "@knowledge-base/locales/src/es-MX/kb.json";
import { createInstance } from "i18next";
import type { MouseEvent, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createdKbDestination,
  createSchema,
  type KbItem,
  KbList,
  KbManageActions,
  kbHref,
  kbMutationErrorAction,
  metadataSchema,
  routerClick,
  slugFromName,
} from "@/components/kb/kb-list";

describe("KB metadata form scalar bounds", () => {
  it("accepts maximum astral lengths in create and edit", () => {
    const metadata = { name: "😀".repeat(120), description: "😀".repeat(2000) };
    expect(createSchema.safeParse({ ...metadata, slug: "scalar-bound" }).success).toBe(true);
    expect(metadataSchema.safeParse(metadata).success).toBe(true);
  });

  it("rejects scalar overflow and descriptions below ten scalars in both forms", () => {
    for (const metadata of [
      { name: "😀".repeat(121), description: "😀".repeat(10) },
      { name: "Valid", description: "😀".repeat(2001) },
      { name: "Valid", description: "😀".repeat(9) },
    ]) {
      expect(createSchema.safeParse({ ...metadata, slug: "scalar-bound" }).success).toBe(false);
      expect(metadataSchema.safeParse(metadata).success).toBe(false);
    }
  });
});

describe("KB create slug", () => {
  it("derives a valid slug from the name", () => {
    expect(slugFromName("Engineering Notes")).toBe("engineering-notes");
    expect(slugFromName("  Café — Équipe #2!  ")).toBe("cafe-equipe-2");
    expect(slugFromName("😀")).toBe("");
    const long = slugFromName(`${"a".repeat(62)} b`);
    expect(long).toBe("a".repeat(62));
    expect(
      createSchema.safeParse({ name: "Valid", description: "Ten chars!", slug: long }).success,
    ).toBe(true);
  });

  it("reports one issue for an empty slug", () => {
    const result = createSchema.safeParse({ name: "Valid", description: "Ten chars!", slug: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const slugIssues = result.error.issues.filter((issue) => issue.path[0] === "slug");
      expect(slugIssues.map((issue) => issue.code)).toEqual(["too_small"]);
    }
  });
});

const KB = "a".repeat(24);
const item = (capabilities: KbItem["capabilities"], isOwner = true): KbItem => ({
  id: KB,
  isOwner,
  name: "Team notes",
  slug: "team-notes",
  description: "Shared engineering notes",
  defaultBranch: "main",
  headSha: "1".repeat(40),
  metadataVersion: 3,
  capabilities,
  writeMode: capabilities.includes("write")
    ? "direct"
    : capabilities.includes("propose")
      ? "proposal_required"
      : "read_only",
  embeddingGeneration: null,
  attachmentLocator: `https://kb.example/mcp#kb=${KB}`,
  sealedNamespace: "00000000-0000-5000-8000-000000000001",
});

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
const html = (node: ReactElement) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);

describe("KbList", () => {
  it("links each KB by locale and shows a member's write mode", () => {
    const out = html(<KbList lang="en-US" items={[item(["read", "propose"], false)]} />);
    expect(out).toContain(`href="/en-US/kbs/${KB}"`);
    expect(out).toContain("Team notes");
    expect(out).toContain(enKb.writeMode.proposal_required);
  });
  it("labels the owner's own KB as Owner, not by write mode", () => {
    const out = html(<KbList lang="en-US" items={[item(["read", "propose", "write"])]} />);
    expect(out).toContain(enKb.access.owner);
    expect(out).not.toContain(enKb.writeMode.direct);
  });
  it("renders the empty state without rows", () => {
    const out = html(<KbList lang="en-US" items={[]} />);
    expect(out).toContain(enKb.list.emptyTitle);
    expect(out).not.toContain("<li");
  });
  it("kbHref encodes the id", () => {
    expect(kbHref("es-MX", KB)).toBe(`/es-MX/kbs/${KB}`);
  });
});

describe("KbManageActions: capability-driven", () => {
  it("read/propose/write without manage shows no metadata or delete control", () => {
    const out = html(
      <KbManageActions
        kb={item(["read", "propose", "write"])}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(out).toBe("");
  });
  it("the owner with manage sees edit and delete", () => {
    const out = html(
      <KbManageActions
        kb={item(["read", "propose", "write", "review", "manage"])}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(out).toContain(enKb.manage.edit);
    expect(out).toContain(enKb.manage.delete);
    expect(out).toContain('data-testid="kb-delete"');
  });
  it("a non-owner manager sees edit but never the owner-only delete", () => {
    const out = html(
      <KbManageActions
        kb={item(["read", "propose", "write", "review", "manage"], false)}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(out).toContain(enKb.manage.edit);
    expect(out).not.toContain(enKb.manage.delete);
    expect(out).not.toContain('data-testid="kb-delete"');
  });
});

describe("KbList sections (Owned / Shared with me)", () => {
  it("renders a section's own empty state", () => {
    const out = html(
      <KbList
        lang="en-US"
        items={[]}
        emptyTitle={enKb.list.sharedEmptyTitle}
        emptyDescription={enKb.list.sharedEmptyDescription}
      />,
    );
    expect(out).toContain(enKb.list.sharedEmptyTitle);
    expect(out).not.toContain(enKb.list.emptyTitle);
  });
  it("marks shared rows as shared", () => {
    const out = html(<KbList lang="en-US" items={[item(["read"], false)]} />);
    expect(out).toContain('data-owner="false"');
    const own = html(<KbList lang="en-US" items={[item(["read", "manage"], true)]} />);
    expect(own).toContain('data-owner="true"');
  });
});

describe("createdKbDestination: respects returned bits", () => {
  it("opens the new KB only when the returned capabilities include read", () => {
    expect(createdKbDestination(item(["read", "manage"]))).toBe("open");
    expect(createdKbDestination(item(["propose"]))).toBe("stay");
    expect(createdKbDestination(item([]))).toBe("stay");
  });
});

describe("kbMutationErrorAction", () => {
  const err = (code: string) => Object.assign(new Error(code), { code });
  it("classifies conflict, not-found and forbidden (denials re-check access)", () => {
    expect(kbMutationErrorAction(err("CONFLICT"))).toBe("conflict");
    expect(kbMutationErrorAction(err("NOT_FOUND"))).toBe("accessLost");
    expect(kbMutationErrorAction(err("FORBIDDEN"))).toBe("forbidden");
    expect(kbMutationErrorAction(new TypeError("offline"))).toBe("error");
  });
});

describe("kb locale parity", () => {
  const keys = (obj: unknown, prefix = ""): string[] =>
    typeof obj === "object" && obj !== null
      ? Object.entries(obj).flatMap(([k, v]) => keys(v, `${prefix}${k}.`))
      : [prefix];
  it("es-MX has exactly the en-US keys", () => {
    expect(keys(esKb).sort()).toEqual(keys(enKb).sort());
  });
});

describe("internal document click gestures", () => {
  const event = (overrides: Record<string, unknown> = {}) =>
    ({
      button: 0,
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      currentTarget: { target: "", hasAttribute: () => false },
      preventDefault: vi.fn(),
      ...overrides,
    }) as unknown as MouseEvent<HTMLAnchorElement>;
  it("soft-navigates plain clicks", () => {
    const open = vi.fn();
    const click = event();
    routerClick(open)(click);
    expect(open).toHaveBeenCalledOnce();
    expect(click.preventDefault).toHaveBeenCalledOnce();
  });
  it.each([
    { button: 1 },
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { defaultPrevented: true },
    { currentTarget: { target: "_blank", hasAttribute: () => false } },
    { currentTarget: { target: "", hasAttribute: () => true } },
  ])("keeps browser gestures native: %s", (gesture) => {
    const open = vi.fn();
    const click = event(gesture);
    routerClick(open)(click);
    expect(open).not.toHaveBeenCalled();
    expect(click.preventDefault).not.toHaveBeenCalled();
  });
});
