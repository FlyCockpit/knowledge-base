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
import { toast } from "@knowledge-base/ui/components/sileo";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { LogOut, User } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAuthSession } from "@/hooks/use-auth-session";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { getNavItems, toLangRoute } from "@/lib/nav-items";
import { setSessionHint } from "@/lib/session-hint";
import { friendly } from "@/utils/friendly-error";

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
  const queryClient = useQueryClient();
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
      {/* A 44px icon below `md:`. From `md:` the name, at most 192px, shrinking
          (to 44px) before the header controls run past the trailing line;
          the name truncates and the full name is the title (same as
          UserMenu's eager trigger). */}
      <DropdownMenuTrigger
        // The visible name starts the accessible name (WCAG 2.5.3): voice
        // control users say what they see.
        aria-label={t("userMenu.openFor", { name: session.user.name })}
        render={
          <Button
            variant="outline"
            size="touch"
            className="w-11 px-0! md:w-auto md:min-w-11 md:max-w-48 md:shrink md:px-3.5!"
            title={session.user.name}
          />
        }
      >
        <User className="size-4 md:hidden" aria-hidden="true" />
        <span className="hidden truncate md:block">{session.user.name}</span>
      </DropdownMenuTrigger>
      {/* At least 224px so the email fits; `end` keeps the menu's trailing
          edge on the trigger's, the header's trailing line. */}
      <DropdownMenuContent align="end" className="min-w-56 bg-card">
        <DropdownMenuGroup>
          {/* Who is signed in, as a label: not an item, so nothing in it
              looks pressable. */}
          <DropdownMenuLabel className="space-y-0.5">
            <span className="block text-muted-foreground">{t("userMenu.myAccount")}</span>
            <span className="block truncate text-foreground">{session.user.name}</span>
            <span className="block truncate font-normal" title={session.user.email}>
              {session.user.email}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
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
            variant="destructive"
            onClick={async () => {
              // Still signed in after a failure: say so, so the user can try
              // again instead of believing they are out.
              const failed = (error: unknown) =>
                toast.error(friendly(error, t("userMenu.signOutFailed")));
              try {
                // Dynamic import keeps the sign-out path out of the menu
                // chunk's critical path; the auth client is already warm once
                // the menu is reachable for a signed-in user.
                const { authClient } = await import("@/lib/auth-client");
                const result = await authClient.signOut({
                  fetchOptions: {
                    onSuccess: () => {
                      // The public pages' cookie hint follows at once, so
                      // the landing page and its header agree (lib/session-hint.ts).
                      setSessionHint(queryClient, false);
                      navigate({
                        to: "/$lang/login",
                        params: { lang },
                        search: { redirectTo: undefined },
                      });
                    },
                  },
                });
                if (result.error) failed(result.error);
              } catch (error) {
                failed(error);
              }
            }}
          >
            <LogOut className="size-4" />
            {t("userMenu.signOut")}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
