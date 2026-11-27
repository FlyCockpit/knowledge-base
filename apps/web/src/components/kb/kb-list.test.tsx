import enCommon from "@knowledge-base/locales/src/en-US/common.json";
import enKb from "@knowledge-base/locales/src/en-US/kb.json";
import esKb from "@knowledge-base/locales/src/es-MX/kb.json";
import { QueryCache, QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { createInstance } from "i18next";
import type { MouseEvent, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createdKbDestination,
  createErrorText,
  createSchema,
  finishKbDeletion,
  type KbItem,
  KbList,
  KbManageActions,
  kbCreateMutationOptions,
  kbHref,
  kbMutationErrorAction,
  metadataSchema,
  routerClick,
  slugFromName,
} from "@/components/kb/kb-list";
import appI18n from "@/i18n";
import { friendly } from "@/utils/friendly-error";

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
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>{node}</I18nextProvider>
    </QueryClientProvider>,
  );

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

describe("create refusal text", () => {
  const refusal = (retryAfterSeconds: number) => ({
    code: "TOO_MANY_REQUESTS",
    data: { reason: "CREATE_LIMIT", limit: 5, windowSeconds: 3600, retryAfterSeconds },
  });
  it("names the hourly limit and when it resets, in en-US and es-MX", async () => {
    const local = createInstance();
    await local.init({
      lng: "en-US",
      fallbackLng: "en-US",
      ns: ["kb", "common"],
      defaultNS: "kb",
      resources: { "en-US": { kb: enKb, common: enCommon }, "es-MX": { kb: esKb } },
      interpolation: { escapeValue: false },
    });
    const t = local.getFixedT("en-US", ["kb", "common"]);
    expect(createErrorText(refusal(3532), t)).toBe(
      "You can create 5 knowledge bases per hour. Try again in 59 minutes.",
    );
    expect(createErrorText(refusal(20), t)).toBe(
      "You can create 5 knowledge bases per hour. Try again in 1 minute.",
    );
    expect(createErrorText(refusal(3532), local.getFixedT("es-MX", ["kb", "common"]))).toBe(
      "Puedes crear 5 bases de conocimiento por hora. Vuelve a intentarlo en 59 minutos.",
    );
    expect(createErrorText({ code: "CONFLICT" }, t)).toBe("Couldn't create the knowledge base.");
    expect(createErrorText({ code: "TOO_MANY_REQUESTS", data: {} }, t)).toBe(
      "Couldn't create the knowledge base.",
    );
  });
  it("says offline or unreachable for a network failure, not the generic create error", async () => {
    const local = createInstance();
    await local.init({
      lng: "en-US",
      ns: ["kb", "common"],
      defaultNS: "kb",
      resources: { "en-US": { kb: enKb, common: enCommon } },
      interpolation: { escapeValue: false },
    });
    const t = local.getFixedT("en-US", ["kb", "common"]);
    const failed = new TypeError("Failed to fetch");
    try {
      vi.stubGlobal("navigator", { onLine: false });
      expect(createErrorText(failed, t)).toBe(friendly(failed));
      expect(createErrorText(failed, t)).toBe(appI18n.t("errors:offline"));
      expect(createErrorText(failed, t)).toMatch(/^You're offline/);
      expect(createErrorText(failed, t)).toMatch(/^You're offline/);
      vi.stubGlobal("navigator", { onLine: true });
      expect(createErrorText(failed, t)).toBe(appI18n.t("errors:unreachable"));
      expect(createErrorText({ code: "CONFLICT" }, t)).toBe("Couldn't create the knowledge base.");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("says a failure once: inline while the dialog is open, as a toast once it was closed", async () => {
    const local = createInstance();
    await local.init({
      lng: "en-US",
      ns: ["kb", "common"],
      defaultNS: "kb",
      resources: { "en-US": { kb: enKb, common: enCommon } },
      interpolation: { escapeValue: false },
    });
    const t = local.getFixedT("en-US", ["kb", "common"]);
    const onSuccess = vi.fn();
    let open = true;
    const notify = vi.fn();
    const options = kbCreateMutationOptions({ onSuccess }, { isOpen: () => open, notify, t });
    // The global toast is skipped (the dialog's inline alert says it) and the base is kept.
    expect(options.meta).toEqual({ skipGlobalErrorToast: true });
    expect(options.onSuccess).toBe(onSuccess);
    options.onError(refusal(3532));
    expect(notify).not.toHaveBeenCalled();
    open = false;
    options.onError(refusal(3532));
    options.onError(new Error("offline"));
    expect(notify.mock.calls).toEqual([
      ["You can create 5 knowledge bases per hour. Try again in 59 minutes."],
      ["Couldn't create the knowledge base."],
    ]);
  });
});

describe("own KB deletion retirement", () => {
  it("cancels scoped reads, leaves cached data until navigation, and clears after observers retire", async () => {
    const errors = vi.fn();
    const client = new QueryClient({
      queryCache: new QueryCache({ onError: errors }),
      defaultOptions: { queries: { retry: false } },
    });
    const key = [["kbs", "get"], { input: { kbId: KB } }];
    const otherKey = [["kbs", "get"], { input: { kbId: "other" } }];
    client.setQueryData(key, { name: "Deleted KB" });
    client.setQueryData(otherKey, { name: "Other KB" });
    let failRead: (error: Error) => void = () => {};
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: () =>
        new Promise<never>((_resolve, reject) => {
          failRead = reject;
        }),
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    const read = observer.refetch();
    const navigate = vi.fn(async () => {
      expect(client.getQueryState(key)?.fetchStatus).toBe("idle");
      expect(client.getQueryData(key)).toEqual({ name: "Deleted KB" });
    });
    await finishKbDeletion(client, KB, navigate, unsubscribe);
    failRead(Object.assign(new Error("No access"), { code: "FORBIDDEN" }));
    await read;
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getQueryData(otherKey)).toEqual({ name: "Other KB" });
    expect(errors).not.toHaveBeenCalled();
  });

  it("clears deleted private data even when navigation rejects", async () => {
    const client = new QueryClient();
    const key = [["kbs", "get"], { input: { kbId: KB } }];
    const otherKey = [["documents", "list"], { input: { kbId: "other" } }];
    client.setQueryData(key, { name: "Deleted KB" });
    client.setQueryData(otherKey, { items: [] });
    const navigationError = new Error("Navigation failed");
    await expect(
      finishKbDeletion(
        client,
        KB,
        async () => {
          throw navigationError;
        },
        () => {},
      ),
    ).rejects.toBe(navigationError);
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getQueryData(otherKey)).toEqual({ items: [] });
  });
});
