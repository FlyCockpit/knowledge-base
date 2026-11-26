import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { cn } from "@knowledge-base/ui/lib/utils";
import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { PanelLeft } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAuthSession } from "@/hooks/use-auth-session";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { type AppNavItem, getNavItems, toLangRoute } from "@/lib/nav-items";
import { useUiPreferences } from "@/stores/ui-preferences";

/** The layouts whose pages are signed in only, so they always show the sidebar. */
const SIGNED_IN_LAYOUTS: ReadonlySet<string> = new Set(["/$lang/_app/_auth", "/$lang/_app/admin"]);

const ASIDE_CLASS =
  "hidden min-h-0 shrink-0 flex-col overflow-x-hidden overflow-y-auto overscroll-contain border-e border-sidebar-border bg-sidebar text-sidebar-foreground md:flex";

/**
 * The signed-in desktop sidebar: main sections, then Settings
 * and Admin at the foot. It collapses to icons and remembers that choice.
 * Below `md` the BottomNav is the only navigation, so this never renders there.
 */
export function AppSidebar() {
  const { t } = useTranslation("nav");
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  const authSession = useAuthSession();
  const collapsed = useUiPreferences((prefs) => prefs.sidebarCollapsed);
  const toggle = useUiPreferences((prefs) => prefs.toggleSidebar);
  const signedInPage = useRouterState({
    select: (state) => state.matches.some((match) => SIGNED_IN_LAYOUTS.has(match.routeId)),
  });
  // While the session loads (the first frame of a hard refresh: `_app`'s
  // pending shell), a signed-in page keeps the sidebar's place, so the content
  // does not narrow when it arrives. Sign-in pages have no sidebar.
  if (authSession.state.status === "pending" && signedInPage)
    return <SidebarSkeleton collapsed={collapsed} />;
  if (authSession.state.status !== "authenticated") return null;
  const items = getNavItems({
    placement: "sidebar",
    isAuthenticated: true,
    role: authSession.state.session.user.role,
  });
  const groups = (["main", "footer"] as const).map((id) => ({
    id,
    items: items.filter((item) => item.group === id),
  }));
  const toggleLabel = collapsed ? t("sidebar.expand") : t("sidebar.collapse");

  return (
    <aside
      data-app-nav="sidebar"
      data-collapsed={collapsed ? "true" : "false"}
      className={cn(
        ASIDE_CLASS,
        "transition-[width] duration-(--duration-base) ease-(--ease-in-out)",
        collapsed ? "w-16" : "w-60",
      )}
    >
      <div className={cn("flex p-2", collapsed ? "justify-center" : "justify-end")}>
        <Button
          type="button"
          variant="ghost"
          size="icon-touch"
          aria-pressed={collapsed}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={toggle}
        >
          <PanelLeft aria-hidden="true" />
        </Button>
      </div>
      <nav aria-label={t("mainNav.ariaLabel")} className="flex flex-1 flex-col gap-1 px-2 pb-4">
        {groups.map((group) =>
          group.items.length === 0 ? null : (
            <div
              key={group.id}
              className={cn(
                "flex flex-col gap-1",
                // Collapsed links are fixed 44px squares: centre them on the rail,
                // the same line the centred collapse toggle sits on.
                collapsed && "items-center",
                group.id === "footer" && "mt-auto border-t border-sidebar-border pt-2",
              )}
            >
              {group.items.map((item) => (
                <SidebarLink key={item.id} item={item} lang={lang} collapsed={collapsed} />
              ))}
            </div>
          ),
        )}
      </nav>
    </aside>
  );
}

/** The sidebar's box while the session loads: same width, links as skeletons. */
function SidebarSkeleton({ collapsed }: { collapsed: boolean }) {
  return (
    <aside
      aria-hidden="true"
      data-app-nav="sidebar"
      data-collapsed={collapsed ? "true" : "false"}
      className={cn(ASIDE_CLASS, collapsed ? "w-16" : "w-60")}
    >
      <div className={cn("flex p-2", collapsed ? "justify-center" : "justify-end")}>
        <Skeleton className="size-11" />
      </div>
      <div className={cn("flex flex-1 flex-col gap-1 px-2 pb-4", collapsed && "items-center")}>
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className={cn("h-11", collapsed ? "w-11" : "w-full")} />
        ))}
      </div>
    </aside>
  );
}

function SidebarLink({
  item,
  lang,
  collapsed,
}: {
  item: AppNavItem;
  lang: string;
  collapsed: boolean;
}) {
  const { t } = useTranslation("nav");
  const label = t(item.labelKey);
  return (
    <Link
      to={toLangRoute(item.path)}
      params={{ lang }}
      activeOptions={{ exact: item.exact }}
      title={collapsed ? label : undefined}
      className={cn(
        buttonVariants({ variant: "ghost", size: collapsed ? "icon-touch" : "touch" }),
        "text-sm text-muted-foreground hover:text-foreground",
        collapsed ? "justify-center" : "justify-start gap-3",
      )}
      activeProps={{ className: "bg-sidebar-accent font-semibold text-sidebar-accent-foreground" }}
    >
      <item.icon aria-hidden="true" className="size-4 shrink-0" />
      <span className={collapsed ? "sr-only" : "min-w-0 truncate"}>{label}</span>
    </Link>
  );
}
