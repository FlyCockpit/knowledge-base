import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
// @ts-expect-error — TanStack exposes the private route component through this Vite split module.
import { component as Component } from "./api-keys?tsr-split=component";

const fixture = vi.hoisted(() => ({
  error: null as unknown,
  confirm: [] as { open: boolean; confirmToken: string; typePrompt: string; title: string }[],
}));
vi.mock("@tanstack/react-router", () => ({
  lazyRouteComponent: () => () => null,
  Link: ({ children }: { children: ReactNode }) => <a href="/en-US/settings/mcp">{children}</a>,
  createFileRoute: () => (options: { component: ComponentType }) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
  }),
}));
vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useInfiniteQuery: () => ({
    data: { pages: [{ items: [{ id: "k1", name: "key-alpha" }] }] },
    error: fixture.error,
    isError: fixture.error !== null,
    isPending: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
    hasNextPage: true,
    isFetchingNextPage: false,
  }),
}));
vi.mock("@/components/kb/api-key-list", () => ({
  ApiKeyList: ({ keys, footer }: { keys: { name: string }[]; footer: ReactNode }) => (
    <div>
      {keys.map((row) => (
        <p key={row.name}>{row.name}</p>
      ))}
      {footer}
    </div>
  ),
  ApiKeyDetailsDialog: () => <div>details-dialog-mounted</div>,
}));
vi.mock("@/components/kb/api-key-create-dialog", () => ({
  ApiKeyCreateDialog: () => <div>create-dialog-mounted</div>,
}));
vi.mock("@/components/confirm-delete-dialog", () => ({
  ConfirmDeleteDialog: (props: {
    open: boolean;
    confirmToken: string;
    typePrompt: string;
    title: string;
  }) => {
    fixture.confirm.push(props);
    return null;
  },
}));

beforeEach(() => {
  fixture.error = null;
  fixture.confirm = [];
});
function render() {
  const client = new QueryClient();
  try {
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <Component />
      </QueryClientProvider>,
    );
  } finally {
    client.clear();
  }
}

it("explains the key, lists keys with Load more and mounts create, details and a closed revoke confirm", () => {
  const out = render();
  expect(out).toContain("settings:apiKeys.intro");
  expect(out).toContain('href="/en-US/settings/mcp"');
  expect(out).toContain("key-alpha");
  expect(out).toContain("actions.loadMore");
  expect(out).toContain("create-dialog-mounted");
  expect(out).toContain("details-dialog-mounted");
  // Revoke is type-to-confirm and closed until a row asks for it.
  expect(fixture.confirm).toEqual([
    expect.objectContaining({
      open: false,
      title: "settings:apiKeys.revokeTitle",
      typePrompt: "settings:credentials.revokeTypePrompt",
    }),
  ]);
});

it("keeps the loaded list after a transient failure, with an inline retry", () => {
  fixture.error = new Error("offline");
  const out = render();
  expect(out).toContain("key-alpha");
  expect(out).toContain("create-dialog-mounted");
  expect(out).toContain("actions.tryAgain");
});

it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])(
  "hides cached keys and dialogs after %s",
  (code) => {
    fixture.error = { code };
    const out = render();
    expect(out).not.toContain("key-alpha");
    expect(out).not.toContain("create-dialog-mounted");
    expect(out).toContain("actions.tryAgain");
  },
);
