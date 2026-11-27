import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  online: true,
  invalidate: vi.fn(async () => undefined),
  reconnect: { retry: undefined as (() => void) | undefined, offline: false },
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ invalidate: fixture.invalidate }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/hooks/use-network-status", () => ({ useNetworkStatus: () => fixture.online }));
vi.mock("@/hooks/use-retry-on-reconnect", () => ({
  useRetryOnReconnect: (retry: () => void, offline: boolean) => {
    fixture.reconnect = { retry, offline };
  },
}));
vi.mock("@/utils/friendly-error", () => ({ friendly: () => "friendly copy" }));
vi.mock("../utils/friendly-error", () => ({ friendly: () => "friendly copy" }));

const { default: ErrorState } = await import("./error-state");

function render(error: unknown): string {
  return renderToStaticMarkup(
    <ErrorState error={error as Error} reset={() => {}} info={{ componentStack: "" }} />,
  );
}

beforeEach(() => {
  fixture.online = true;
  fixture.invalidate.mockClear();
});

describe("ErrorState", () => {
  it("offline: says the page will load on reconnect and retries when the status turns back online", () => {
    fixture.online = false;
    const html = render(new TypeError("Failed to fetch dynamically imported module: /a.js"));
    expect(html).toContain("errors:offlinePage.title");
    expect(html).toContain("errors:offlinePage.description");
    expect(html).not.toContain("common:somethingWentWrong");
    expect(fixture.reconnect.offline).toBe(true);
    fixture.reconnect.retry?.();
    expect(fixture.invalidate).toHaveBeenCalledTimes(1);
  });

  it("online fetch failure: says the server could not be reached", () => {
    const html = render(new TypeError("Failed to fetch"));
    expect(html).toContain("errors:unreachablePage.title");
    expect(fixture.reconnect.offline).toBe(false);
  });

  it("generic Try again re-runs the failed matches (a failed session guard included)", () => {
    // ErrorState's hooks are all mocked here, so it can be called directly.
    const tree = ErrorState({
      error: new Error("Route session unavailable"),
      reset: () => {},
      info: { componentStack: "" },
    });
    const buttons: { props: { onClick?: () => void; children?: unknown } }[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object" || !("props" in node)) return;
      const element = node as { props: { onClick?: () => void; children?: unknown } };
      if (element.props.onClick) buttons.push(element);
      walk(element.props.children);
    };
    walk(tree);
    const tryAgain = buttons.find((button) => button.props.children === "common:actions.tryAgain");
    tryAgain?.props.onClick?.();
    expect(fixture.invalidate).toHaveBeenCalledTimes(1);
  });

  it("anything else online: the generic error with Try again and Reload", () => {
    const html = render(new Error("boom"));
    expect(html).toContain("common:somethingWentWrong");
    expect(html).toContain("friendly copy");
    expect(html).toContain("common:actions.reload");
  });
});
