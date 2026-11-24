import { appShortName } from "@knowledge-base/env/app-name";
import { env } from "@knowledge-base/env/web";
import { Link } from "@tanstack/react-router";

/**
 * The header brand at the start of both header rows (the app shell's `Header`
 * and the public `PublicHeader`), so the two can never size it differently:
 * the full name from `sm` up, the short one on phones.
 *
 * The brand only takes the room the rest of the row leaves it, so it is the
 * first thing to give way and the controls never run past the header's
 * trailing line, whatever the name's length, the width or the locale. Its flex
 * basis is 0 (`basis-0 grow`): it grows into what is left after the controls,
 * up to its own width (`max-w-fit`), and never below a 44px target
 * (`min-w-11`). A shrink factor cannot do this: CSS has no shrink order, and
 * any factor still hands the controls a fraction of a pixel, enough to cut
 * the account name short. With a MainNav in the row the two share what is
 * left. The spans' caps (160px, 224px from `sm:`, 320px from `lg:`) keep a long
 * name from taking the MainNav's room. A name that does not fit ends in an
 * ellipsis (the `truncate` spans: an ellipsis needs a block box, and
 * `truncate` on the inline-flex link only clips), and the full name is the
 * link's `title` and accessible name.
 */
export function AppBrand({ lang }: { lang: string }) {
  const appName = env.VITE_APP_NAME;
  return (
    <Link
      to="/$lang"
      params={{ lang }}
      aria-label={appName}
      title={appName}
      className="inline-flex min-h-11 min-w-11 max-w-fit grow basis-0 items-center font-heading text-lg font-semibold tracking-tight"
    >
      <span aria-hidden="true" className="max-w-40 truncate sm:hidden">
        {appShortName(appName)}
      </span>
      <span aria-hidden="true" className="hidden max-w-56 truncate sm:block lg:max-w-80">
        {appName}
      </span>
    </Link>
  );
}
