import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
// @ts-expect-error — TanStack exposes the private route component through this Vite split module.
import { component as Component } from "./mcp?tsr-split=component";

const fixture = vi.hoisted(() => ({
  calls: 0,
  tokenError: null as unknown,
  grantError: null as unknown,
}));
vi.mock("@tanstack/react-router", () => ({
  lazyRouteComponent: () => () => null,
  createFileRoute: () => (options: { component: ComponentType }) => ({
    options,
    useParams: () => ({ lang: "en-US" }),
    useSearch: () => ({}),
  }),
}));
vi.mock("react-i18next", async (original) => ({
  ...(await original<typeof import("react-i18next")>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: () => ({ data: undefined, isError: false }),
  useInfiniteQuery: () => {
    const token = fixture.calls++ % 2 === 0;
    const error = token ? fixture.tokenError : fixture.grantError;
    return {
      data: { pages: [{ items: [{ name: token ? "token-alpha" : "grant-beta" }] }] },
      error,
      isError: error !== null,
      isPending: false,
      refetch: vi.fn(),
      fetchNextPage: vi.fn(),
      hasNextPage: true,
      isFetchingNextPage: false,
    };
  },
}));
vi.mock("@/components/kb/credential-list", () => ({
  CredentialList: ({
    tokens,
    grants,
  }: {
    tokens: { name: string }[];
    grants: { name: string }[];
  }) => (
    <div>
      {[...tokens, ...grants].map((row) => (
        <p key={row.name}>{row.name}</p>
      ))}
    </div>
  ),
  PatCreateDialog: () => <div>credential-dialog-mounted</div>,
  editTargetFromToken: vi.fn(),
  editTargetFromGrant: vi.fn(),
}));
vi.mock("@/components/kb/grant-edit-sheet", () => ({ GrantEditSheet: () => null }));
vi.mock("@/components/confirm-delete-dialog", () => ({ ConfirmDeleteDialog: () => null }));

beforeEach(() => {
  fixture.calls = 0;
  fixture.tokenError = null;
  fixture.grantError = null;
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
it.each(["tokens", "grants"])(
  "keeps both loaded credential lists and dialogs after a transient %s failure",
  (list) => {
    if (list === "tokens") fixture.tokenError = new Error("offline");
    else fixture.grantError = new Error("offline");
    const out = render();
    expect(out).toContain("token-alpha");
    expect(out).toContain("grant-beta");
    expect(out).toContain("credential-dialog-mounted");
    expect(out).toContain("actions.tryAgain");
  },
);
it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND"])(
  "hides cached credentials and dialogs after %s",
  (code) => {
    fixture.tokenError = { code };
    const out = render();
    expect(out).not.toContain("token-alpha");
    expect(out).not.toContain("grant-beta");
    expect(out).not.toContain("credential-dialog-mounted");
    expect(out).toContain("actions.tryAgain");
  },
);
