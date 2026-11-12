import { SelectorRow } from "@knowledge-base/ui/components/selector-row";
import { cn } from "@knowledge-base/ui/lib/utils";
import { createFileRoute, Link, notFound, Outlet } from "@tanstack/react-router";
import { LayoutDashboard, ListX, Settings, Users } from "lucide-react";
import { useTranslation } from "react-i18next";

import { TwoFactorNudge } from "@/components/admin/two-factor-nudge";
import { decideAdminRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";

export const Route = createFileRoute("/$lang/_app/admin")({
  beforeLoad: async () => {
    const decision = decideAdminRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    // 404-hide the entire admin tree from confirmed non-admins. Throwing
    // notFound() (instead of redirect) means an unauthorized visitor can't
    // tell whether /admin exists at all — same response as a route that
    // doesn't exist. Resolution failures are route errors, not 404s.
    if (decision.kind === "not-found") throw notFound();
    return { session: decision.session };
  },
  component: AdminLayout,
});

function AdminLayout() {
  return (
    <div className="min-h-full">
      <AdminNav />
      <TwoFactorNudge />
      <Outlet />
    </div>
  );
}

function AdminNav() {
  const { lang } = Route.useParams();
  const { t } = useTranslation("admin");
  const NAV_ITEMS = [
    {
      to: "/$lang/admin" as const,
      label: t("nav.overview"),
      icon: LayoutDashboard,
      exact: true,
    },
    {
      to: "/$lang/admin/users" as const,
      label: t("nav.users"),
      icon: Users,
      exact: false,
    },
    {
      to: "/$lang/admin/jobs" as const,
      label: t("nav.jobs"),
      icon: ListX,
      exact: false,
    },
    {
      to: "/$lang/admin/settings" as const,
      label: t("nav.settings"),
      icon: Settings,
      exact: false,
    },
  ];
  return (
    <nav
      aria-label={t("nav.ariaLabel")}
      className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur"
    >
      <div className="container mx-auto min-w-0 max-w-7xl">
        <SelectorRow className="-mb-px" innerClassName="gap-1 px-4 py-2">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              params={{ lang }}
              activeOptions={{ exact: item.exact }}
              className={cn(
                "inline-flex min-h-[44px] shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
              )}
              activeProps={{
                className: "bg-muted text-foreground",
              }}
            >
              <item.icon aria-hidden="true" className="size-4" />
              <span>{item.label}</span>
            </Link>
          ))}
        </SelectorRow>
      </div>
    </nav>
  );
}
