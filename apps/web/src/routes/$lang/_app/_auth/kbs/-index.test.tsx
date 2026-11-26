import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — TanStack exposes the private route component through this Vite split module.
import { component as Component } from "./index?tsr-split=component";

/**
 * The signed-in home (`APP_HOME`): the getting-started checklist above the
 * two lists, every tick read from data, and a count in each list's heading.
 * docs/ui.md § The signed-in home.
 */
type Page = { items: { id: string }[]; nextCursor: string | null };
const fixture = vi.hoisted(() => ({
  role: "user" as string,
  /** False: mounted without the `_auth` gate's context (the KB browser harness). */
  hasSession: true,
  owned: undefined as Page[] | undefined,
  shared: [{ items: [], nextCursor: null }] as Page[] | undefined,
  /** `mcpGrants.countActiveMine`: the counts, or "error". */
  counts: { tokens: 0, apps: 0, apiKeys: 0, childTokens: 0 } as
    | { tokens: number; apps: number; apiKeys: number; childTokens: number }
    | "error"
    | undefined,
  /** `kbs.shareStatusMine`, or "error". */
  sharing: { shared: false } as { shared: boolean } | "error" | undefined,
  /** Admin `users.list({ limit: 1 })`'s cursor: set once a second account exists. */
  users: { users: [{}], nextCursor: null } as { users: unknown[]; nextCursor: string | null },
  enabled: {} as Record<string, boolean | undefined>,
  refetchOnMount: {} as Record<string, unknown>,
  listError: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", () => ({
  lazyRouteComponent: () => () => null,
  createFileRoute: () => (options: { component: ComponentType }) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
    useRouteContext: () => ({
      session: fixture.hasSession ? { user: { id: "u1", role: fixture.role } } : undefined,
    }),
  }),
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    params,
    search,
    children,
  }: {
    to: string;
    params?: { kbId?: string };
    search?: { tab?: string };
    children: ReactNode;
  }) => (
    <a data-to={to} data-kb={params?.kbId} data-tab={search?.tab}>
      {children}
    </a>
  ),
}));
vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join(",")})` : key,
  }),
}));
vi.mock("@/utils/orpc", () => ({
  orpc: {
    kbs: {
      list: {
        infiniteOptions: (options: { input: (cursor: null) => { relation: string } }) => ({
          relation: options.input(null).relation,
        }),
        key: () => ["kbs", "list"],
      },
      shareStatusMine: { queryOptions: () => ({ read: "sharing" }), key: () => ["sharing"] },
    },
    mcpGrants: {
      countActiveMine: { queryOptions: () => ({ read: "counts" }), key: () => ["counts"] },
    },
    users: { list: { queryOptions: () => ({ read: "users" }), key: () => ["users"] } },
  },
}));
const result = (data: unknown, enabled = true) => {
  if (!enabled) return { isPending: true, isSuccess: false, isError: false, data: undefined };
  if (data === "error") return { isPending: false, isSuccess: false, isError: true };
  if (data === undefined) return { isPending: true, isSuccess: false, isError: false };
  return { isPending: false, isSuccess: true, isError: false, data };
};
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useInfiniteQuery: ({ relation }: { relation: "owned" | "shared" }) => {
    const pages = fixture[relation];
    const error = fixture.listError[relation];
    return {
      ...result(pages && { pages, pageParams: [] }),
      ...(error ? { error, isError: true } : {}),
      hasNextPage: Boolean(pages?.at(-1)?.nextCursor),
      isFetchingNextPage: false,
      refetch: vi.fn(),
      fetchNextPage: vi.fn(),
    };
  },
  useQuery: ({
    read,
    enabled = true,
    refetchOnMount,
  }: {
    read: "counts" | "sharing" | "users";
    enabled?: boolean;
    refetchOnMount?: unknown;
  }) => {
    fixture.enabled[read] = enabled;
    fixture.refetchOnMount[read] = refetchOnMount;
    return result(fixture[read], enabled);
  },
}));
vi.mock("@/components/kb/kb-list", () => ({
  KbList: ({ items }: { items: unknown[] }) => <ul data-kb-list={items.length} />,
  KbCreateDialog: () => null,
  KB_GRID_CLASS: "sm:grid-cols-2",
  createdKbDestination: () => "open",
}));
vi.mock("@knowledge-base/ui/components/sileo", () => ({ toast: { message: vi.fn() } }));

const hidden = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/getting-started", async (original) => ({
  ...(await original<typeof import("@/lib/getting-started")>()),
  isGettingStartedHidden: () => hidden.value,
}));

const render = () => renderToStaticMarkup(<Component />);
const steps = (html: string) =>
  [...html.matchAll(/data-step="([^"]*)"( data-done="")?/g)].map(([, id, done]) => ({
    id,
    done: Boolean(done),
  }));
const ONE_KB = [{ items: [{ id: "kb1" }], nextCursor: null }];

beforeEach(() => {
  fixture.role = "user";
  fixture.hasSession = true;
  fixture.owned = [{ items: [], nextCursor: null }];
  fixture.listError = {};
  fixture.shared = [{ items: [], nextCursor: null }];
  fixture.counts = { tokens: 0, apps: 0, apiKeys: 0, childTokens: 0 };
  fixture.sharing = { shared: false };
  fixture.users = { users: [{}], nextCursor: null };
  fixture.enabled = {};
  hidden.value = false;
});

describe("getting started on the knowledge bases list", () => {
  it("a new user: Create, Connect an AI client and Share, all to do", () => {
    const html = render();
    expect(steps(html)).toEqual([
      { id: "create-kb", done: false },
      { id: "connect-client", done: false },
      { id: "share-kb", done: false },
    ]);
    expect(html).toContain('data-to="/$lang/settings/mcp"');
    // The checklist comes before the lists.
    expect(html.indexOf("gettingStarted.title")).toBeLessThan(html.indexOf("list.owned"));
  });

  it("ticks Create once the user owns a knowledge base", () => {
    fixture.owned = ONE_KB;
    expect(steps(render())[0]).toEqual({ id: "create-kb", done: true });
  });

  it("ticks Connect for a live token, a key-minted token or a connected app, not an API key", () => {
    fixture.counts = { tokens: 0, apps: 1, apiKeys: 0, childTokens: 0 };
    expect(steps(render())[1]).toEqual({ id: "connect-client", done: true });
    fixture.counts = { tokens: 0, apps: 0, apiKeys: 3, childTokens: 0 };
    expect(steps(render())[1]).toEqual({ id: "connect-client", done: false });
  });

  it("Share: opens the create dialog without a knowledge base, else its members tab", () => {
    expect(render()).toContain("gettingStarted.shareKb.descriptionNoKb");
    expect(render()).not.toContain('data-to="/$lang/kbs/$kbId/settings"');
    fixture.owned = ONE_KB;
    expect(render()).toContain(
      'data-to="/$lang/kbs/$kbId/settings" data-kb="kb1" data-tab="members"',
    );
  });

  it("ticks Share once the server says the user shared a knowledge base", () => {
    fixture.sharing = { shared: true };
    expect(steps(render())[2]).toEqual({ id: "share-kb", done: true });
  });

  it("admins also get Invite someone, ticked once a second account exists", () => {
    fixture.role = "admin";
    expect(steps(render()).at(-1)).toEqual({ id: "invite", done: false });
    expect(render()).toContain('data-to="/$lang/admin/users"');
    fixture.users = { users: [{}], nextCursor: "c" };
    expect(steps(render()).at(-1)).toEqual({ id: "invite", done: true });
  });

  it("is gone once every step is done", () => {
    fixture.owned = ONE_KB;
    fixture.counts = { tokens: 1, apps: 0, apiKeys: 0, childTokens: 0 };
    fixture.sharing = { shared: true };
    expect(render()).not.toContain("gettingStarted.title");
  });

  it("leaves out a step whose read failed instead of guessing", () => {
    fixture.counts = "error";
    fixture.sharing = "error";
    expect(steps(render()).map((step) => step.id)).toEqual(["create-kb"]);
  });

  it("waits for every read behind it (no skeleton, no wrong ticks)", () => {
    fixture.counts = undefined;
    expect(render()).not.toContain("gettingStarted.title");
    fixture.counts = { tokens: 0, apps: 0, apiKeys: 0, childTokens: 0 };
    fixture.owned = undefined;
    expect(render()).not.toContain("gettingStarted.title");
    fixture.owned = ONE_KB;
    fixture.sharing = undefined;
    expect(render()).not.toContain("gettingStarted.title");
  });

  it("without a session in the route context (test harness): the lists alone, no reads", () => {
    fixture.hasSession = false;
    const html = render();
    expect(html).not.toContain("gettingStarted.title");
    expect(html).toContain("list.owned");
    expect(fixture.enabled).toEqual({});
  });

  it("re-asks the steps done elsewhere (connect, share) every time the home mounts", () => {
    render();
    expect(fixture.refetchOnMount.counts).toBe("always");
    expect(fixture.refetchOnMount.sharing).toBe("always");
  });

  it("hidden: renders nothing and runs none of its reads", () => {
    hidden.value = true;
    fixture.role = "admin";
    expect(render()).not.toContain("gettingStarted.title");
    expect(fixture.enabled).toEqual({ counts: false, sharing: false, users: false });
  });
});

describe("list headings", () => {
  it("count what is loaded, with + while more pages exist, and nothing when empty", () => {
    fixture.owned = [{ items: [{ id: "a" }, { id: "b" }], nextCursor: "next" }];
    fixture.shared = [{ items: [{ id: "c" }], nextCursor: null }];
    const html = render();
    expect(html).toMatch(/list\.owned<span[^>]*>.*?list\.countMore\(2\)<\/span><\/h2>/);
    expect(html).toMatch(/list\.shared<span[^>]*>.*?list\.count\(1\)<\/span><\/h2>/);
    fixture.shared = [{ items: [], nextCursor: null }];
    expect(render()).toMatch(/list\.shared<\/h2>/);
  });

  it("hide a cached count once the list read fails with an access error (session revoked)", () => {
    fixture.owned = [{ items: [{ id: "a" }, { id: "b" }], nextCursor: null }];
    fixture.listError.owned = { status: 401 };
    expect(render()).toMatch(/list\.owned<\/h2>/);
    fixture.listError.owned = new Error("network");
    expect(render()).toMatch(/list\.owned<span[^>]*>.*?list\.count\(2\)<\/span><\/h2>/);
  });
});
