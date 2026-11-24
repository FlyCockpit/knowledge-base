/**
 * CSS variable on <html>: how much of the bottom of the viewport the
 * first-visit cookie banner covers (unset while no banner shows).
 *
 * The banner is fixed to the bottom of the viewport, so without this it would
 * lie over the page: on a phone it covered the login page's "Sign Up" link.
 * `index.css` turns it into `--consent-clearance`, and every shell pads its
 * bottom by that, so `<main>` ends where the banner starts and every link can
 * be scrolled into view above it. The app shell takes the larger of that and
 * the BottomNav's clearance (on a phone the banner already reaches down behind
 * the BottomNav); the others the larger of it and the safe-area inset.
 */
export const CONSENT_INSET_VAR = "--consent-inset";

/**
 * The height the banner covers: its border box plus its distance from the
 * bottom edge (`bottom-0` on phones, `md:bottom-4` as a card). Layout sizes,
 * not `getBoundingClientRect()`: the entrance animation's transform must not
 * shorten the reservation while it plays.
 */
export function consentInsetPx(offsetHeight: number, bottom: string): number {
  const offset = Number.parseFloat(bottom);
  return Math.ceil(offsetHeight + (Number.isFinite(offset) ? Math.max(0, offset) : 0));
}

/**
 * Ref callback for the banner: publishes {@link CONSENT_INSET_VAR} while the
 * banner is mounted and keeps it current as the banner resizes (wrapping text,
 * a breakpoint, a rotation); the window `resize` covers a breakpoint that only
 * moves it. Removes the variable when the banner unmounts (a choice was made).
 * Module-level so its identity is stable and React attaches it once.
 */
export function reserveConsentInset(banner: HTMLElement | null): (() => void) | undefined {
  if (!banner) return undefined;
  const root = document.documentElement;
  const publish = () => {
    const px = consentInsetPx(banner.offsetHeight, getComputedStyle(banner).bottom);
    root.style.setProperty(CONSENT_INSET_VAR, `${px}px`);
  };
  publish();
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
  observer?.observe(banner);
  window.addEventListener("resize", publish);
  return () => {
    observer?.disconnect();
    window.removeEventListener("resize", publish);
    root.style.removeProperty(CONSENT_INSET_VAR);
  };
}
