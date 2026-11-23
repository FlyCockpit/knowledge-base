import { Button } from "@knowledge-base/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@knowledge-base/ui/components/dropdown-menu";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { useAuthSession } from "@/hooks/use-auth-session";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { getNavItems, toLangRoute } from "@/lib/nav-items";

/**
 * The real Base UI account menu. Lazy-loaded by `user-menu.tsx` on first
 * interaction so the shared Base UI overlay chunk stays off the eager bundle
 * (UserMenu mounts in the root on every page). It mounts `defaultOpen` so the
 * click that triggered the load opens the menu immediately — no effect, no
 * second click. Only rendered when a session is present.
 */
export default function UserMenuContent() {
  const navigate = useNavigate();
  // `strict: false` so the menu renders under both prefixed and (briefly) the
  // top-level `/` redirect route without throwing.
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  const authSession = useAuthSession();
  const { t } = useTranslation("nav");

  // The shell only renders this once a session exists; guard defensively so a
  // session-expiry race can't dereference a null user.
  if (authSession.state.status !== "authenticated") return null;
  const session = authSession.state.session;

  const userMenuItems = getNavItems({
    placement: "userMenu",
    isAuthenticated: true,
    role: session.user.role,
  });

  return (
    <DropdownMenu defaultOpen>
      {/* Shrinks to 44px and truncates the name before the header controls
          run past the trailing line (same as UserMenu's eager trigger). */}
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="touch"
            className="min-w-11 max-w-48 shrink"
            title={session.user.name}
          />
        }
      >
        <span className="truncate">{session.user.name}</span>
      </DropdownMenuTrigger>
      {/* At least 224px so the email fits; `end` keeps the menu's trailing
          edge on the trigger's, the header's trailing line. */}
      <DropdownMenuContent align="end" className="min-w-56 bg-card">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("userMenu.myAccount")}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem title={session.user.email}>
            <span className="truncate">{session.user.email}</span>
          </DropdownMenuItem>
          {userMenuItems.map((item) => (
            <DropdownMenuItem
              key={item.id}
              onClick={() => navigate({ to: toLangRoute(item.path), params: { lang } })}
            >
              <item.icon className="size-4" />
              {t(item.labelKey)}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            inset
            variant="destructive"
            onClick={async () => {
              // Dynamic import keeps the sign-out path out of the menu chunk's
              // critical path; the auth client is already warm once the menu
              // is reachable for a signed-in user.
              const { authClient } = await import("@/lib/auth-client");
              authClient.signOut({
                fetchOptions: {
                  onSuccess: () => {
                    navigate({
                      to: "/$lang/login",
                      params: { lang },
                      search: { redirectTo: undefined },
                    });
                  },
                },
              });
            }}
          >
            {t("userMenu.signOut")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
