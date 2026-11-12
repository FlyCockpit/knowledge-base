import { useParams } from "@tanstack/react-router";

import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";

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

  return (
    <div>
      <div className="flex min-w-0 flex-row items-center gap-2 px-3 py-2 sm:gap-4 sm:px-4">
        <AppBrand lang={lang} />
        <MainNav />
        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          <LanguageSwitcher />
          <ModeToggle />
          <UserMenu />
        </div>
      </div>
      <hr />
    </div>
  );
}
