import { Card, CardContent, CardHeader } from "@knowledge-base/ui/components/card";
import { SelectorRow } from "@knowledge-base/ui/components/selector-row";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useMatch, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { AuthScreenSkeleton } from "@/components/auth/auth-config-gate";
import { AuthScreen } from "@/components/auth/auth-screen";
import { SkeletonList } from "@/components/skeleton-list";
import { KB_GRID_CLASS } from "@/lib/kb-grid";
import { settingsNavItems } from "@/lib/nav-items";
import {
  type PendingFrame,
  type PendingLayout,
  type PendingShape,
  type PendingWidth,
  resolvePendingLayout,
} from "@/lib/pending-layout";
import { TREE_WIDTH_DEFAULT } from "@/stores/kb-workspace";

// The `PageShell` widths (components/page-shell.tsx), so the skeleton's
// columns line up with the page that replaces it.
const WIDTH_CLASS: Record<PendingWidth, string> = {
  narrow: "max-w-4xl",
  default: "max-w-5xl",
  wide: "max-w-7xl",
  full: "max-w-none",
};
const PAGE_SHELL_CLASS = "container mx-auto space-y-6 px-4 py-6 md:py-8";

/**
 * The content-area skeleton for the route that is loading, shaped by its
 * `staticData` (lib/pending-layout.ts). It never draws app chrome: the app
 * shell renders around it (`_app`'s pending component, and every pending
 * boundary below it, sit inside the shell's `<main>`), so the header, the nav
 * and the bottom nav are the real ones from the first frame.
 *
 * It is the router's `defaultPendingComponent`, `_app`'s pending content and
 * the forced-2FA gate's loading state.
 */
export function RouteContentSkeleton() {
  const routeId = useMatch({ strict: false, select: (match) => match.routeId });
  // The matches of the location being loaded (a pending route is already in
  // `matches`, with status "pending"), leaf last.
  const matches = useRouterState({ select: (state) => state.matches });
  return <ContentSkeleton layout={resolvePendingLayout(matches, routeId)} />;
}

/** The skeleton markup for a resolved layout. */
function ContentSkeleton({ layout }: { layout: PendingLayout }) {
  if (layout.shape === "auth")
    // The sign-in pages' centred card (AuthCard), not a page container.
    return (
      <div data-route-skeleton="auth" aria-busy="true">
        <AuthScreen>
          <AuthScreenSkeleton />
        </AuthScreen>
      </div>
    );
  let body: ReactNode = <ShapeSkeleton shape={layout.shape} />;
  // Innermost frame first: a settings form inside the settings frame inside
  // nothing else.
  for (const frame of [...layout.frames].reverse()) {
    body = (
      <FrameSkeleton frame={frame} width={layout.width}>
        {body}
      </FrameSkeleton>
    );
  }
  const framed = layout.frames.length > 0;
  return (
    <div
      data-route-skeleton={layout.shape}
      aria-busy="true"
      className={cn(
        // Inside a layout that already draws the page container (settings, a
        // KB), the skeleton is the content alone.
        layout.contained ? "space-y-6" : !framed && [PAGE_SHELL_CLASS, WIDTH_CLASS[layout.width]],
      )}
    >
      {body}
    </div>
  );
}

function FrameSkeleton({
  frame,
  width,
  children,
}: {
  frame: PendingFrame;
  width: PendingWidth;
  children: ReactNode;
}) {
  if (frame === "admin") {
    // The admin layout: a sticky, full-bleed sub-nav of 44px links, then the
    // page in its own `PageShell`.
    return (
      <>
        <div className="border-b">
          <div className="container mx-auto flex max-w-7xl gap-1 overflow-hidden px-4 py-2">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-11 w-24 shrink-0 rounded-md" />
            ))}
          </div>
        </div>
        <div className={cn(PAGE_SHELL_CLASS, WIDTH_CLASS[width])}>{children}</div>
      </>
    );
  }
  if (frame === "workspace") {
    // A KB's workspace (components/kb/kb-workspace.tsx), full width: from
    // 1024px the file tree at its default width and the resize handle's line,
    // then the toolbar and the padded pane with the breadcrumbs. The KB home
    // keeps its centred column inside the pane; a document uses the whole pane.
    // (The tree's width and whether it is open come from local storage, so a
    // resized or hidden tree can still move the pane once on a hard refresh.)
    return (
      <div className="flex min-h-full min-w-0" data-pending-frame="workspace">
        <div
          className="hidden shrink-0 flex-col border-e bg-sidebar/40 lg:flex"
          style={{ width: TREE_WIDTH_DEFAULT }}
        >
          {/* The KB name row (44px controls), then the Files / Search /
              Outline / Activity selector (SegmentedControl), then the files. */}
          <div className="flex min-h-11 items-center gap-1 border-b px-2">
            <div className="flex h-11 flex-1 items-center px-1">
              <Skeleton className="h-5 w-32" />
            </div>
          </div>
          <div className="border-b px-2 py-1.5">
            <SelectorRow>
              <div className="inline-flex w-max flex-row items-center gap-1 rounded-md border p-1">
                {Array.from({ length: 4 }, (_, index) => (
                  <Skeleton key={index} className="min-h-[44px] w-14 shrink-0 rounded-sm" />
                ))}
              </div>
            </SelectorRow>
          </div>
          <div className="space-y-2 p-3">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-6 w-1/2" />
          </div>
        </div>
        <div className="hidden w-1.5 shrink-0 lg:block" />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-11 items-center gap-1 border-b px-2">
            <div className="flex h-11 items-center gap-2">
              <Skeleton className="h-7 w-28" />
              <Skeleton className="h-7 w-28" />
            </div>
          </div>
          <div className="min-w-0 flex-1 px-4 py-4 md:px-6 md:py-6">
            <div className="space-y-6">
              <BreadcrumbsSkeleton />
              {width === "full" ? (
                children
              ) : (
                <div className="mx-auto max-w-6xl space-y-6">{children}</div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (frame === "kb") {
    // A KB's layout (routes/$lang/_app/_auth/kbs/$kbId.tsx): the page shell
    // with the breadcrumbs above whatever the KB page shows.
    return (
      <div className={cn(PAGE_SHELL_CLASS, WIDTH_CLASS[width])}>
        <BreadcrumbsSkeleton />
        {children}
      </div>
    );
  }
  // The settings layout (its own max-w-4xl container): title, then a side nav
  // (a row on phones, one item per settings page) and the section's content.
  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      <Skeleton className="mb-6 h-8 w-32" />
      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <div className="flex gap-1 md:w-48 md:shrink-0 md:flex-col">
          {settingsNavItems.map((item) => (
            <Skeleton key={item.path} className="h-11 w-24 shrink-0 rounded-md md:h-9 md:w-full" />
          ))}
        </div>
        <div className="min-w-0 flex-1 space-y-6">{children}</div>
      </div>
    </div>
  );
}

function HeaderSkeleton({ action }: { action?: boolean }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-2">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-5 w-64 max-w-full" />
      </div>
      {action ? <Skeleton className="h-11 w-32" /> : null}
    </div>
  );
}

/**
 * The breadcrumbs (components/breadcrumbs.tsx): one row of 44px crumbs, pulled
 * up by the layout's `-mt-2`.
 */
function BreadcrumbsSkeleton() {
  return (
    <div className="-mt-2 flex min-h-11 items-center">
      <Skeleton className="h-5 w-48" />
    </div>
  );
}

function ShapeSkeleton({ shape }: { shape: PendingShape }) {
  switch (shape) {
    case "list":
      return (
        <>
          <HeaderSkeleton action />
          <Card>
            <CardHeader className="space-y-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent className="p-0">
              <SkeletonList count={4} />
            </CardContent>
          </Card>
        </>
      );
    case "detail":
      return (
        <>
          <HeaderSkeleton action />
          <Skeleton className="h-48 w-full rounded-lg" />
          <div className="space-y-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </>
      );
    case "form":
      return (
        <>
          <HeaderSkeleton />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }, (_, index) => (
              <div key={index} className="space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-11 w-full md:h-8" />
              </div>
            ))}
          </div>
          <Skeleton className="h-11 w-32" />
        </>
      );
    case "cards":
      // The knowledge bases page (the signed-in home): "Owned" and "Shared
      // with me", each a heading over its own loading grid of KB cards.
      return (
        <>
          <HeaderSkeleton action />
          {Array.from({ length: 2 }, (_, section) => (
            <div key={section} className="min-w-0 space-y-3">
              <Skeleton className="h-7 w-40" />
              <div className={cn("grid gap-3", KB_GRID_CLASS)}>
                <Skeleton className="h-32 w-full rounded-xl" />
                <Skeleton className="h-32 w-full rounded-xl" />
              </div>
            </div>
          ))}
        </>
      );
    case "document":
      // A KB document (routes/$lang/_app/_auth/kbs/$kbId/documents.tsx): the
      // page's own loading state, title, path and the body at the long-read
      // measure, in every mode.
      return (
        <div className="space-y-4">
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-[50svh] w-full max-w-[72ch]" />
        </div>
      );
    case "overview":
      // The admin overview: a status card, then a grid of section cards.
      return (
        <>
          <HeaderSkeleton />
          <Skeleton className="h-28 w-full rounded-xl" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-32 w-full rounded-xl" />
            ))}
          </div>
        </>
      );
    case "auth":
      // Drawn by ContentSkeleton, around no page container.
      return null;
  }
}
