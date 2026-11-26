import { Button, buttonVariants } from "@knowledge-base/ui/components/button";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { cn } from "@knowledge-base/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { LogIn, User, UserPlus } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";

import { useAuthSession } from "@/hooks/use-auth-session";
import { DEFAULT_LOCALE, isSupportedLocale } from "@/i18n/config";
import { signupMode } from "@/lib/signup-mode";
import { orpc } from "@/utils/orpc";

// Lazy so the shared Base UI overlay chunk (Menu/Dialog/focus-guards) leaves the
// eager first-paint bundle. Only the signed-in branch touches Base UI; the
// pending Skeleton and signed-out Buttons/Links stay fully eager. The shell
// below reproduces the trigger Button exactly, so the swap is zero-CLS.
const UserMenuContent = lazy(() => import("./user-menu-content"));

// Warm the chunk on hover/focus. The module cache dedupes repeat calls, so the
// click handler that follows resolves instantly from cache.
function prefetchMenu() {
  void import("./user-menu-content");
}

export default function UserMenu() {
  // `strict: false` so the menu renders under both prefixed and (briefly) the
  // top-level `/` redirect route without throwing.
  const params = useParams({ strict: false });
  const lang = isSupportedLocale(params.lang) ? params.lang : DEFAULT_LOCALE;
  const authSession = useAuthSession();
  const { data: configData, isPending: configPending } = useQuery(orpc.appConfig.queryOptions());
  const { t } = useTranslation("nav");
  // The user the real menu was opened for. Keyed by user id (not a plain
  // boolean) so signing out and back in as someone else — the component stays
  // mounted in the header — returns to the closed shell instead of reusing the
  // lazy menu, which mounts `defaultOpen`, already open for the new user.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  // Whether an identity was ever confirmed in this mount, so a later error
  // shows the account control (disabled) instead of a loading skeleton.
  const [hadIdentity, setHadIdentity] = useState(false);
  const state = authSession.state;
  if (state.status === "authenticated" && !hadIdentity) setHadIdentity(true);

  if (state.status === "pending") {
    return <Skeleton className="h-11 w-24" />;
  }

  // A known identity whose session check is failing (offline, server
  // unreachable): the account control stays where it was, disabled. It is not
  // loading, so no skeleton; and it is not signed out, so no Sign In.
  if (state.status === "error") {
    if (!hadIdentity) return <Skeleton className="h-11 w-24" />;
    return (
      <Button variant="outline" size="icon-touch" disabled aria-label={t("userMenu.open")}>
        <User className="size-4" aria-hidden="true" />
      </Button>
    );
  }

  if (state.status === "anonymous") {
    // Default to NOT showing Sign Up until the flag is known, so it never
    // flashes when signup is disabled. The admin bootstrap counts: it is on
    // only until an administrator exists (appConfig), and then the operator
    // needs this way in. Forced SSO never offers it: the sign-up page refuses
    // it and the identity provider is the only way in (lib/signup-mode.ts).
    const mode = !configPending && configData ? signupMode(configData) : undefined;
    const showSignUp = mode === "open" || mode === "bootstrap";
    return (
      <div className="flex items-center gap-2">
        {/* Below `sm:` both are 44px icon buttons, named by `aria-label`, so
            the row never runs past its trailing line at 320px; the text
            labels show from `sm:` up. */}
        {showSignUp && (
          <Link
            to="/$lang/signup"
            params={{ lang }}
            search={{ redirectTo: undefined }}
            aria-label={t("userMenu.signUp")}
            className={cn(buttonVariants({ size: "touch" }), "w-11 px-0 sm:w-auto sm:px-3.5")}
          >
            <UserPlus className="size-4 sm:hidden" aria-hidden="true" />
            <span className="hidden sm:inline">{t("userMenu.signUp")}</span>
          </Link>
        )}
        <Link
          to="/$lang/login"
          params={{ lang }}
          search={{ redirectTo: undefined }}
          aria-label={t("userMenu.signIn")}
          className={cn(
            buttonVariants({ size: "touch", variant: "outline" }),
            "w-11 px-0 sm:w-auto sm:px-3.5",
          )}
        >
          <LogIn className="size-4 sm:hidden" aria-hidden="true" />
          <span className="hidden sm:inline">{t("userMenu.signIn")}</span>
        </Link>
      </div>
    );
  }

  const session = state.session;

  // The eager placeholder: visually identical to UserMenuContent's trigger so
  // there is no layout shift when the real control loads. `inert` while the
  // lazy chunk is in flight (Suspense fallback) so it can't take a second,
  // ignored click.
  const shell = (inert: boolean) => (
    <Button
      variant="outline"
      size="touch"
      aria-label={t("userMenu.openFor", { name: session.user.name })}
      aria-haspopup="menu"
      // Same as UserMenuContent's trigger: a 44px icon below `md:`; from
      // `md:` the name, at most 192px, shrinking (to 44px) before the header
      // controls run past the trailing line, truncated.
      className="w-11 px-0! md:w-auto md:min-w-11 md:max-w-48 md:shrink md:px-3.5!"
      title={session.user.name}
      inert={inert}
      onPointerEnter={prefetchMenu}
      onFocus={prefetchMenu}
      onClick={() => {
        prefetchMenu();
        setOpenedFor(session.user.id);
      }}
    >
      <User className="size-4 md:hidden" aria-hidden="true" />
      <span className="hidden truncate md:block">{session.user.name}</span>
    </Button>
  );

  if (openedFor !== session.user.id) return shell(false);

  return (
    <Suspense fallback={shell(true)}>
      <UserMenuContent key={session.user.id} />
    </Suspense>
  );
}
