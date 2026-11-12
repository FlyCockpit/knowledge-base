import { appShortName } from "@knowledge-base/env/app-name";
import { env } from "@knowledge-base/env/web";
import { Link } from "@tanstack/react-router";

/** The header brand: the full name from `sm` up, the short one on phones. */
export function AppBrand({ lang }: { lang: string }) {
  const appName = env.VITE_APP_NAME;
  return (
    <Link
      to="/$lang"
      params={{ lang }}
      aria-label={appName}
      className="inline-flex min-h-11 min-w-11 max-w-40 shrink-0 items-center truncate font-heading text-lg font-semibold tracking-tight sm:max-w-56 lg:max-w-none"
    >
      <span aria-hidden="true" className="sm:hidden">
        {appShortName(appName)}
      </span>
      <span aria-hidden="true" className="hidden sm:inline">
        {appName}
      </span>
    </Link>
  );
}
