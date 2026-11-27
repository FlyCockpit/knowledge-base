import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  APP_SHELL_ATTRIBUTE,
  APP_SHELL_HYDRATION_TIMEOUT_MS,
  appShellHydrated,
  markAppShellHydrated,
  resetAppShellHydrationForTests,
} from "./app-shell-hydration";

const mountEffects = vi.hoisted(() => [] as unknown[]);
vi.mock("@/hooks/use-mount-effect", () => ({
  useMountEffect: (fn: unknown) => {
    mountEffects.push(fn);
  },
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: Record<string, unknown>) => ({ options }),
  // The router plugin splits route components into `lazyRouteComponent`.
  lazyRouteComponent: (importer: () => Promise<Record<string, unknown>>, name = "default") => ({
    importer,
    name,
  }),
  Outlet: () => null,
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({}) }));
vi.mock("@tanstack/react-query-devtools", () => ({ ReactQueryDevtools: () => null }));
vi.mock("@tanstack/react-router-devtools", () => ({ TanStackRouterDevtools: () => null }));
vi.mock("@/components/admin-setup-banner", () => ({ AdminSetupBanner: () => null }));
vi.mock("@/components/app-sidebar", () => ({ AppSidebar: () => null }));
vi.mock("@/components/offline-band", () => ({ OfflineBand: () => null }));
vi.mock("@/components/bottom-nav", () => ({ default: () => null }));
vi.mock("@/components/header", () => ({ default: () => null }));
vi.mock("@/components/route-content-skeleton", () => ({ RouteContentSkeleton: () => null }));
vi.mock("@/hooks/use-document-lang", () => ({ useDocumentLang: () => {} }));
vi.mock("@/hooks/use-mobile-keyboard", () => ({ useMobileKeyboard: () => false }));
vi.mock("@/hooks/use-user-locale-sync", () => ({ useUserLocaleSync: () => {} }));
vi.mock("@/hooks/use-reload-on-identity-change", () => ({ useReloadOnIdentityChange: () => {} }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

/** A document whose server HTML does (or does not) hold the app shell. */
function stubDocument(hasAppShell: boolean) {
  const querySelector = vi.fn((selector: string) =>
    hasAppShell && selector === `[${APP_SHELL_ATTRIBUTE}]` ? {} : null,
  );
  vi.stubGlobal("document", { querySelector });
  return querySelector;
}

/** Whether the promise has settled after the queued microtasks ran. */
async function settled(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

beforeEach(() => {
  resetAppShellHydrationForTests();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("appShellHydrated", () => {
  it("holds a guard while the server-rendered shell has not hydrated", async () => {
    stubDocument(true);
    const wait = appShellHydrated();
    expect(await settled(wait)).toBe(false);

    markAppShellHydrated();
    expect(await settled(wait)).toBe(true);
  });

  it("resolves at once after the shell hydrated (every later navigation)", async () => {
    stubDocument(true);
    markAppShellHydrated();
    expect(await settled(appShellHydrated())).toBe(true);
  });

  it("resolves at once when the document holds no app shell (from a public page)", async () => {
    stubDocument(false);
    expect(await settled(appShellHydrated())).toBe(true);
  });

  it("resolves at once on the server", async () => {
    expect(typeof document).toBe("undefined");
    expect(await settled(appShellHydrated())).toBe(true);
  });

  it("never holds a guard forever if the shell stops reporting", async () => {
    stubDocument(true);
    const wait = appShellHydrated();
    vi.advanceTimersByTime(APP_SHELL_HYDRATION_TIMEOUT_MS - 1);
    expect(await settled(wait)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await settled(wait)).toBe(true);
  });

  it("clears a waiter's timer once the shell reports", async () => {
    stubDocument(true);
    const wait = appShellHydrated();
    expect(vi.getTimerCount()).toBe(1);
    markAppShellHydrated();
    expect(await settled(wait)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("resolveRouteSession", () => {
  it("runs the probe at once but decides only after the shell hydrated", async () => {
    vi.resetModules();
    const probe = vi.fn(async () => ({ status: "resolved" as const, session: null }));
    const admit = vi.fn(async () => undefined);
    vi.doMock("@/server/auth-session", () => ({ getRouteSession: probe }));
    vi.doMock("@/lib/document-identity", () => ({
      admitRouteIdentity: admit,
      identityVerificationGeneration: () => 0,
      isDocumentIdentityUnverified: () => false,
    }));
    const hydration = await import("./app-shell-hydration");
    const { resolveRouteSession } = await import("./route-session");
    stubDocument(true);

    const resolution = resolveRouteSession();
    expect(probe).toHaveBeenCalledOnce();
    expect(await settled(resolution.then(() => undefined))).toBe(false);
    expect(admit).not.toHaveBeenCalled();

    hydration.markAppShellHydrated();
    await expect(resolution).resolves.toEqual({ status: "resolved", session: null });
    expect(admit).toHaveBeenCalledOnce();
    vi.doUnmock("@/server/auth-session");
    vi.doUnmock("@/lib/document-identity");
  });

  it("delivers a failed probe only after the shell hydrated", async () => {
    vi.resetModules();
    const failure = new Error("network down");
    const probe = vi.fn(async () => {
      throw failure;
    });
    const admit = vi.fn(async () => undefined);
    vi.doMock("@/server/auth-session", () => ({ getRouteSession: probe }));
    vi.doMock("@/lib/document-identity", () => ({
      admitRouteIdentity: admit,
      identityVerificationGeneration: () => 0,
      isDocumentIdentityUnverified: () => false,
    }));
    const hydration = await import("./app-shell-hydration");
    const { resolveRouteSession } = await import("./route-session");
    stubDocument(true);

    let rejected: unknown;
    const resolution = resolveRouteSession().then(
      () => undefined,
      (error: unknown) => {
        rejected = error;
      },
    );
    expect(probe).toHaveBeenCalledOnce();
    expect(await settled(resolution)).toBe(false);
    expect(rejected).toBeUndefined();

    hydration.markAppShellHydrated();
    await resolution;
    expect(rejected).toBe(failure);
    expect(admit).not.toHaveBeenCalled();
    vi.doUnmock("@/server/auth-session");
    vi.doUnmock("@/lib/document-identity");
  });
});

describe("every session guard", () => {
  it("probes through resolveRouteSession, never getRouteSession alone", () => {
    const routes = resolve(import.meta.dirname, "../routes");
    const guards: string[] = [];
    for (const file of readdirSync(routes, { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/.test(file) || file.includes(".test.")) continue;
      const text = readFileSync(resolve(routes, file), "utf8");
      expect(text, file).not.toMatch(/\bgetRouteSession\b/);
      if (text.includes("resolveRouteSession()")) guards.push(file);
    }
    expect(guards.length).toBeGreaterThanOrEqual(9);
  });
});

describe("the _app shell frame", () => {
  it("marks itself in the server HTML and reports hydration from its first effect", async () => {
    const { Route } = await import("@/routes/$lang/_app/route");
    const hydration = await import("./app-shell-hydration");
    type Split = { importer: () => Promise<Record<string, unknown>>; name: string };
    const { options } = Route as unknown as {
      options: Record<"component" | "pendingComponent", (() => ReactNode) | Split>;
    };
    const frames: (() => ReactNode)[] = [];
    for (const key of ["pendingComponent", "component"] as const) {
      const value = options[key];
      frames.push(
        typeof value === "function"
          ? value
          : ((await value.importer())[value.name] as () => ReactNode),
      );
    }
    for (const Frame of frames) {
      mountEffects.length = 0;
      const html = renderToStaticMarkup(createElement(Frame));
      expect(html.match(new RegExp(`${hydration.APP_SHELL_ATTRIBUTE}=""`, "g"))).toHaveLength(1);
      expect(mountEffects).toContain(hydration.markAppShellHydrated);
    }
  }, 30_000); // Loads the real route module and its code-split chunks cold.
});
