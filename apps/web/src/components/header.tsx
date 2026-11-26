import { cn } from "@knowledge-base/ui/lib/utils";
import { useParams } from "@tanstack/react-router";

import { useAuthSession } from "@/hooks/use-auth-session";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { APP_HOME } from "@/lib/app-home";

import { AppBrand } from "./app-brand";
import { LanguageSwitcher } from "./language-switcher";
import { MainNav } from "./main-nav";
import { ModeToggle } from "./mode-toggle";
import UserMenu from "./user-menu";

export default function Header() {
  // `strict: false` lets this component render under any route (including the
  // top-level `/` redirect) without throwing when the `lang` param is absent.
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  const isAuthenticated = useAuthSession().state.status === "authenticated";

  return (
    <div>
      <div className="flex min-w-0 flex-row items-center gap-2 px-4 py-2 sm:gap-4">
        {/* The first thing in the row to give way (see AppBrand). Signed in,
            it goes to the signed-in home rather than the landing page. */}
        <AppBrand lang={lang} to={isAuthenticated ? APP_HOME : "/$lang"} />
        <MainNav />
        {/* Signed out (and while the session loads) nothing in the controls
            group can shrink, so it never does. Signed in, the account trigger
            gives way once the brand is down to its 44px. */}
        <div
          className={cn(
            "ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2",
            !isAuthenticated && "shrink-0",
          )}
        >
          <LanguageSwitcher />
          <ModeToggle />
          <UserMenu />
        </div>
      </div>
      <hr />
    </div>
  );
}
