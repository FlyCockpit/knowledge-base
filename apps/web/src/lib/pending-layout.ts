/**
 * What a route looks like while it loads, declared on the route itself
 * (`staticData`) so the skeleton the user sees first has the page's shape:
 * a list, a card grid, a detail view or a form, at the page's width, inside
 * the layout chrome (the admin sub-nav, the settings side nav, a KB's
 * breadcrumbs) that the page
 * sits in.
 * See docs/ui.md § Route pending states
 *
 *   export const Route = createFileRoute("/$lang/_app/_auth/kbs/")({
 *     staticData: { pendingShape: "list", pendingWidth: "narrow" },
 *     component: KbsPage,
 *   });
 *
 * A layout route that draws its own chrome around its children sets
 * `pendingFrame` (or a function of the leaf route's id); leaf routes set `pendingShape` (default "list"; "auth" is
 * the centred sign-in card) and `pendingWidth` (default "default", the
 * `PageShell` widths).
 */
export type PendingShape = "list" | "cards" | "detail" | "document" | "form" | "overview" | "auth";
export type PendingFrame = "admin" | "settings" | "kb" | "workspace";
export type PendingWidth = "narrow" | "default" | "wide" | "full";

/**
 * A layout whose chrome depends on the page below it (a KB's layout draws the
 * workspace for its home and documents, its page column for the rest) passes
 * a function of the leaf route's id.
 */
type PendingFrameOption = PendingFrame | ((leafRouteId: string) => PendingFrame);

/**
 * Frames whose layout draws the page container itself (the settings layout's
 * `max-w-4xl` container, a KB's `PageShell`): a skeleton inside one that is
 * already on screen adds no container of its own. The admin layout draws only
 * its sub-nav; its pages bring their own `PageShell`.
 */
const CONTAINER_FRAMES: ReadonlySet<PendingFrame> = new Set(["settings", "kb", "workspace"]);

const KB_ROUTE_ID = "/$lang/_app/_auth/kbs/$kbId";

/**
 * A KB layout's frame (routes/$lang/_app/_auth/kbs/$kbId.tsx): its home and
 * its documents are the workspace (file tree, tabs, read/edit pane); its
 * other pages (settings, pull requests) keep the page column.
 */
export const kbPendingFrame = (leafRouteId: string): PendingFrame =>
  leafRouteId === KB_ROUTE_ID || leafRouteId === `${KB_ROUTE_ID}/documents` ? "workspace" : "kb";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    pendingShape?: PendingShape;
    pendingWidth?: PendingWidth;
    pendingFrame?: PendingFrameOption;
  }
}

export type PendingLayout = {
  shape: PendingShape;
  width: PendingWidth;
  frames: PendingFrame[];
  /** A layout above the loading boundary already draws the page container. */
  contained: boolean;
};

type MatchLike = {
  routeId: string;
  staticData?: {
    pendingShape?: PendingShape;
    pendingWidth?: PendingWidth;
    pendingFrame?: PendingFrameOption;
  };
};

function frameOf(match: MatchLike, leafRouteId: string): PendingFrame | undefined {
  const option = match.staticData?.pendingFrame;
  return typeof option === "function" ? option(leafRouteId) : option;
}

/**
 * The skeleton for the matches from `fromRouteId` (the route whose pending
 * boundary is showing) down to the leaf. Frames above that route are already
 * on screen (their layout rendered), so only the ones at or below it are
 * drawn; the leaf decides the shape and width.
 */
export function resolvePendingLayout(
  matches: readonly MatchLike[],
  fromRouteId: string | undefined,
): PendingLayout {
  const start = Math.max(
    fromRouteId ? matches.findIndex((match) => match.routeId === fromRouteId) : 0,
    0,
  );
  const below = matches.slice(start);
  const leafRouteId = matches.at(-1)?.routeId ?? "";
  const contained = matches.slice(0, start).some((match) => {
    const frame = frameOf(match, leafRouteId);
    return frame !== undefined && CONTAINER_FRAMES.has(frame);
  });
  const frames: PendingFrame[] = [];
  for (const match of below) {
    const frame = frameOf(match, leafRouteId);
    if (frame) frames.push(frame);
  }
  const leaf = [...below].reverse().find((match) => match.staticData?.pendingShape);
  const widthMatch = [...below].reverse().find((match) => match.staticData?.pendingWidth);
  return {
    shape: leaf?.staticData?.pendingShape ?? "list",
    width: widthMatch?.staticData?.pendingWidth ?? "default",
    frames,
    contained,
  };
}
