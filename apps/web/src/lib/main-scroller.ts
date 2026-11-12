/**
 * The app shell's <main> is the only page scroller (the document never scrolls). It carries
 * `data-scroll-restoration-id` with this value so TanStack Router keys its saved scroll position
 * by a stable selector, and the router resets it to the top on new navigations.
 */
export const MAIN_SCROLLER_ID = "app-main";

export const MAIN_SCROLLER_SELECTOR = `[data-scroll-restoration-id="${MAIN_SCROLLER_ID}"]`;
