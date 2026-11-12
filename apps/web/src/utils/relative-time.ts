const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/**
 * Locale-aware "in 23 hours" / "dentro de 23 horas" for a timestamp, picking
 * the largest unit the distance fills. Pass the active i18n language so the
 * phrasing follows the `/$lang/...` the user is on, not the browser default.
 *
 * `numeric: "always"` on purpose: a deadline reads better as "in 1 day" than
 * as "tomorrow", which hides how much of the window is left.
 */
export function formatRelativeTime(
  targetMs: number,
  locale: string,
  now: number = Date.now(),
): string {
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "always" });
  const diffMs = targetMs - now;
  for (const [unit, unitMs] of RELATIVE_UNITS) {
    if (Math.abs(diffMs) >= unitMs) {
      return formatter.format(Math.round(diffMs / unitMs), unit);
    }
  }
  return formatter.format(Math.round(diffMs / 60_000), "minute");
}
