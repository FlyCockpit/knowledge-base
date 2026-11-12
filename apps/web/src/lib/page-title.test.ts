import { env } from "@knowledge-base/env/web";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { orpc } from "@/utils/orpc";

import { cachedKbName, isNotFoundHead, pageHead, pageTitle, routeHead } from "./page-title";

describe("pageTitle (R2-12)", () => {
  it("orders the page, its context and the app name, skipping missing parts", () => {
    expect(pageTitle("a.md", "Engineering Notes")).toBe(
      `a.md · Engineering Notes · ${env.VITE_APP_NAME}`,
    );
    expect(pageTitle("Documents", null, " ")).toBe(`Documents · ${env.VITE_APP_NAME}`);
    expect(pageHead("Users", "Admin")).toEqual({
      meta: [{ title: `Users · Admin · ${env.VITE_APP_NAME}` }],
    });
  });

  it("reads the KB name only from the cache", () => {
    const queryClient = new QueryClient();
    const kbId = "a".repeat(24);
    expect(cachedKbName(queryClient, kbId)).toBeNull();
    // An untyped key: the test needs only the field the title reads.
    const key: readonly unknown[] = orpc.kbs.get.queryKey({ input: { kbId } });
    queryClient.setQueryData(key, { kb: { name: "Engineering Notes" } });
    expect(cachedKbName(queryClient, kbId)).toBe("Engineering Notes");
  });

  it("names a not-found page, whichever route is the boundary (R3-W9)", () => {
    const ok = { status: "success" };
    expect(isNotFoundHead([ok, ok])).toBe(false);
    expect(isNotFoundHead([ok, { status: "success", _notFound: true }])).toBe(true);
    expect(isNotFoundHead([ok, { status: "notFound" }])).toBe(true);
    const i18n = {
      t: (key: string) => (key === "errors:pageNotFound.title" ? "Page not found" : key),
    };
    const head = (matches: { status: string; _notFound?: boolean }[]) =>
      routeHead({ matches, match: { context: { i18n: i18n as never } } }, "Engineering Notes");
    expect(head([ok])).toEqual({ meta: [{ title: `Engineering Notes · ${env.VITE_APP_NAME}` }] });
    expect(head([ok, { status: "success", _notFound: true }])).toEqual({
      meta: [{ title: `Page not found · ${env.VITE_APP_NAME}` }],
    });
  });
});
