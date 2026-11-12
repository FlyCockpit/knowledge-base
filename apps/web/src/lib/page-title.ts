import { env } from "@knowledge-base/env/web";
import type { QueryClient } from "@tanstack/react-query";
import type { i18n as I18n } from "i18next";

import { orpc } from "@/utils/orpc";

/**
 * Per-page `<title>` (R2-12, WCAG 2.4.2): the page's own name first, then its
 * context, then the app name — "postgres-failover.md · Engineering Notes ·
 * KnowledgeBase". Empty parts (a KB name not loaded yet) are skipped. The
 * deepest route's `head()` wins over the root's app-name title.
 */
export function pageTitle(...parts: (string | null | undefined)[]): string {
  return [...parts.map((part) => part?.trim()), env.VITE_APP_NAME].filter(Boolean).join(" · ");
}

export function pageHead(...parts: (string | null | undefined)[]) {
  return { meta: [{ title: pageTitle(...parts) }] };
}

/** What a route's `head()` needs to know whether it is a not-found page. */
type HeadMatch = { status: string; _notFound?: boolean };

/**
 * True when the router renders a not-found page at or below this match: an
 * unknown URL (the boundary match carries `_notFound`) or a thrown
 * `notFound()` (`status: "notFound"`). Only the boundary's own `head()` and
 * its ancestors run, and the deepest title wins, so the root and every
 * layout route that can be a boundary must ask this (R3-W9).
 */
export function isNotFoundHead(matches: readonly HeadMatch[]): boolean {
  return matches.some((match) => match._notFound === true || match.status === "notFound");
}

/** `pageHead`, unless the route is showing the not-found page instead. */
export function routeHead(
  head: { matches: readonly HeadMatch[]; match: { context: { i18n: I18n } } },
  ...parts: (string | null | undefined)[]
) {
  return isNotFoundHead(head.matches)
    ? pageHead(head.match.context.i18n.t("errors:pageNotFound.title"))
    : pageHead(...parts);
}

/**
 * The KB's name when the app already holds it (`kbs.get`, else the KB
 * list). No request is made here: the KB layout's loader primes `kbs.get`
 * before any `head()` runs (heads run after the loaders), so a cold first
 * load names the KB too.
 */
export function cachedKbName(queryClient: QueryClient, kbId: string): string | null {
  const data = queryClient.getQueryData(orpc.kbs.get.queryKey({ input: { kbId } }));
  return data?.kb.name ?? null;
}
