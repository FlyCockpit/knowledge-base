import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { Link, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { useAuthSession } from "@/hooks/use-auth-session";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { getNavItems, toLangRoute } from "@/lib/nav-items";

export default function BottomNav({ hidden }: { hidden?: boolean }) {
  // `strict: false` keeps this safe to render under any matched route (the
  // top-level `/` redirect leaves no `lang` param). Fall back to the default
  // locale rather than crashing.
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  const authSession = useAuthSession();
  const { t } = useTranslation("nav");
  const session = authSession.state.status === "authenticated" ? authSession.state.session : null;
  const items = getNavItems({
    placement: "mobile",
    isAuthenticated: authSession.state.status === "authenticated",
    role: session?.user.role,
  });

  if (hidden) return null;

  if (authSession.state.status === "pending" || authSession.state.status === "error") {
    return (
      <nav
        className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background/80 backdrop-blur-lg md:hidden"
        style={{ paddingBottom: "var(--safe-area-bottom)" }}
      >
        <div className="flex h-14 items-center justify-around">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-10 w-16 rounded-md" />
          ))}
        </div>
      </nav>
    );
  }

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-50 border-t bg-background/80 backdrop-blur-lg md:hidden"
      style={{ paddingBottom: "var(--safe-area-bottom)" }}
    >
      <div className="flex h-14 items-center justify-around">
        {items.map((item) => (
          <Link
            key={item.id}
            to={toLangRoute(item.path)}
            params={{ lang }}
            activeOptions={{ exact: item.exact }}
            className="flex flex-col items-center justify-center gap-0.5 px-3 py-1.5 text-muted-foreground transition-colors min-w-[64px] min-h-[44px]"
            activeProps={{
              className:
                "flex flex-col items-center justify-center gap-0.5 px-3 py-1.5 text-primary transition-colors min-w-[64px] min-h-[44px]",
            }}
          >
            <item.icon className="size-5" />
            <span className="text-[10px] font-medium leading-tight">{t(item.labelKey)}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
