/**
 * The KB card grid's columns: as many 15rem-or-wider columns as the list's
 * width holds: one on phones, two on most tablets, three in the default page
 * column. It follows the column, not the viewport, so the sidebar's width
 * counts, and it is rem, so a 4K screen gets the same three columns, scaled,
 * instead of two cards stretched across the screen. See docs/ui.md § Viewport scale
 *
 * Shared by the card lists (KbList, the dashboard), their loading skeletons
 * and the route skeleton (components/route-content-skeleton.tsx), so a
 * skeleton's cards are the width of the cards that replace them.
 */
export const KB_GRID_CLASS = "grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))]";
