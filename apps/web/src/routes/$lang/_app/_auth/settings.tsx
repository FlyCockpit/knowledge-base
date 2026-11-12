import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import NotFoundState from "@/components/not-found-state";
import { settingsNavItems } from "@/lib/nav-items";

export const Route = createFileRoute("/$lang/_app/_auth/settings")({
  component: SettingsLayout,
  // An unknown settings page renders inside this layout, under its "Settings" h1.
  notFoundComponent: () => <NotFoundState nested />,
});

type SettingsRoute =
  | "/$lang/settings"
  | "/$lang/settings/security"
  | "/$lang/settings/mcp"
  | "/$lang/settings/embedding-providers";

function SettingsLayout() {
  const { lang } = Route.useParams();
  const { t } = useTranslation("settings");
  // Rendered from the shared, ordered settings navigation.
  const navItems = settingsNavItems.map((item) => ({
    to: `/$lang${item.path}` as SettingsRoute,
    label: t(item.labelKey),
    icon: item.icon,
    exact: item.exact,
  }));

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold mb-6">{t("title")}</h1>
      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <nav className="w-full min-w-0 md:w-48 flex-shrink-0">
          <div className="-mx-4 flex flex-row gap-1 overflow-x-auto overflow-y-hidden overscroll-x-contain px-4 no-scrollbar md:mx-0 md:flex-col md:overflow-x-visible md:overflow-y-visible md:overscroll-auto md:px-0">
            {navItems.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                params={{ lang }}
                activeOptions={{ exact: item.exact }}
                className="flex min-h-11 md:min-h-9 shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors md:shrink"
                activeProps={{
                  className:
                    "flex min-h-11 md:min-h-9 shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm bg-accent text-accent-foreground transition-colors md:shrink",
                }}
              >
                <item.icon className="size-4" />
                {item.label}
              </Link>
            ))}
          </div>
        </nav>
        <div className="flex-1 min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
