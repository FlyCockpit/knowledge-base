import { isAdminRole } from "@knowledge-base/auth/roles";
import type { LucideIcon } from "lucide-react";
import { BookOpen, Boxes, Home, KeyRound, KeySquare, Settings, Shield } from "lucide-react";

/** `guest`: public pages for signed-out visitors (signed-in users have their home, `APP_HOME`). */
type NavAudience = "public" | "guest" | "authenticated" | "admin";
/**
 * - `desktop`: the header's main nav (signed-out visitors; signed-in users get the sidebar).
 * - `sidebar`: the signed-in desktop sidebar.
 * - `mobile`: the BottomNav tabs.
 * - `userMenu`: the account menu.
 */
type NavPlacement = "desktop" | "sidebar" | "mobile" | "userMenu";
export type AppNavPath =
  | "/"
  | "/kbs"
  | "/settings"
  | "/admin"
  | "/settings/security"
  | "/settings/mcp"
  | "/settings/api-keys"
  | "/settings/embedding-providers";
export type LangNavRoute =
  | "/$lang"
  | "/$lang/kbs"
  | "/$lang/settings"
  | "/$lang/admin"
  | "/$lang/settings/security"
  | "/$lang/settings/mcp"
  | "/$lang/settings/api-keys"
  | "/$lang/settings/embedding-providers";

export type RouteNavItem = {
  /** Path WITHOUT the `/$lang/` prefix, starts with "/". Use "/" for root. */
  path: AppNavPath;
  /** Translation key. App nav keys live in `nav`; nested nav may use another namespace. */
  labelKey: string;
  /** Icon rendered by shell navigation surfaces. */
  icon: LucideIcon;
  /** `activeOptions.exact` for the <Link>. */
  exact: boolean;
};

export type AppNavItem = RouteNavItem & {
  id: "home" | "kbs" | "settings" | "admin";
  audience: NavAudience;
  placements: readonly NavPlacement[];
  /** Sidebar group: the main sections, or the footer (settings, admin). */
  group: "main" | "footer";
};

type VisibleNavInput = {
  placement: NavPlacement;
  isAuthenticated: boolean;
  role?: unknown;
};

const appNavItems: AppNavItem[] = [
  {
    id: "home",
    path: "/",
    labelKey: "items.home",
    icon: Home,
    exact: true,
    // The landing page; a signed-in user's home is the knowledge bases list
    // (`APP_HOME`), so the BottomNav does not show both.
    audience: "guest",
    placements: ["desktop", "mobile"],
    group: "main",
  },
  {
    id: "kbs",
    path: "/kbs",
    labelKey: "items.knowledgeBases",
    icon: BookOpen,
    exact: false,
    audience: "authenticated",
    placements: ["sidebar", "mobile"],
    group: "main",
  },
  {
    id: "settings",
    path: "/settings",
    labelKey: "items.settings",
    icon: Settings,
    exact: false,
    audience: "authenticated",
    placements: ["sidebar", "mobile", "userMenu"],
    group: "footer",
  },
  {
    id: "admin",
    path: "/admin",
    labelKey: "items.admin",
    icon: Shield,
    exact: false,
    audience: "admin",
    placements: ["sidebar", "mobile", "userMenu"],
    group: "footer",
  },
];

function canSeeNavItem(item: AppNavItem, input: Pick<VisibleNavInput, "isAuthenticated" | "role">) {
  if (item.audience === "public") return true;
  if (item.audience === "guest") return !input.isAuthenticated;
  if (!input.isAuthenticated) return false;
  if (item.audience === "authenticated") return true;
  return isAdminRole(input.role);
}

export function getNavItems(input: VisibleNavInput): AppNavItem[] {
  return appNavItems.filter(
    (item) => item.placements.includes(input.placement) && canSeeNavItem(item, input),
  );
}

export function toLangRoute(path: AppNavPath): LangNavRoute {
  if (path === "/") return "/$lang";
  return `/$lang${path}` as LangNavRoute;
}

/** Settings sub-nav tabs, in their rendered order. */
export const settingsNavItems: RouteNavItem[] = [
  {
    path: "/settings",
    labelKey: "settings:navProfile",
    icon: Settings,
    exact: true,
  },
  {
    path: "/settings/security",
    labelKey: "settings:navSecurity",
    icon: Shield,
    exact: false,
  },
  {
    path: "/settings/mcp",
    labelKey: "settings:navMcp",
    icon: KeyRound,
    exact: false,
  },
  {
    path: "/settings/api-keys",
    labelKey: "settings:navApiKeys",
    icon: KeySquare,
    exact: false,
  },
  {
    path: "/settings/embedding-providers",
    labelKey: "settings:navProviders",
    icon: Boxes,
    exact: false,
  },
];
