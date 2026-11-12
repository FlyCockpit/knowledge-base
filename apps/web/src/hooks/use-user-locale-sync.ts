import { useMutation } from "@tanstack/react-query";
import { useParams, useRouter } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useAuthSession } from "@/hooks/use-auth-session";
import i18n from "@/i18n";
import { isSupportedLocale } from "@/i18n/config";
import { orpc } from "@/utils/orpc";

/**
 * Sync a signed-in user's stored locale (Prisma `User.locale`) into the
 * i18n detection chain. Order: URL `:lang` (always wins) → localStorage →
 * **user.locale** → navigator → DEFAULT_LOCALE.
 *
 * The sync is bidirectional: when localStorage carries an explicit device
 * choice that differs from the server-side preference, the choice is pushed
 * UP to the server. This is how a locale picked on a PUBLIC page reaches
 * `User.locale` — the public branch renders session-free (see
 * `_public/route.tsx`), so its language switcher persists only to
 * localStorage and this hook settles the server on the next `_app` visit.
 *
 * Why a hook instead of an i18next-browser-languagedetector entry: the
 * session resolves asynchronously (after the initial i18n init), so the
 * detector chain has already settled by the time we know who the user is.
 * The cleanest path is to detect the session resolution in React and
 * navigate to the user's preferred locale URL once — which then drives
 * the existing `urlPath` detector + `$lang` beforeLoad flow.
 *
 * We deliberately skip the redirect when:
 *   - the user is unauthenticated (no preference to honor),
 *   - the user has explicitly set a different locale this session
 *     (`localStorage.locale` exists — that beats the server-side preference,
 *     mirroring the i18next detector order),
 *   - the URL already matches the user's preferred locale (no-op),
 *   - the stored locale is not in `SUPPORTED_LOCALES` (server may carry an
 *     older value that was retired client-side).
 *
 * Lives in `apps/web/src/hooks/` — the approved escape hatch for
 * `useEffect` per CLAUDE.md "React useEffect Policy."
 */
export function useUserLocaleSync(): void {
  const authSession = useAuthSession();
  const router = useRouter();
  // `strict: false` so we render under the brief `/` redirect window where
  // `lang` isn't matched yet.
  const params = useParams({ strict: false });

  const userLocale =
    authSession.state.status === "authenticated" && !authSession.meta.isDegraded
      ? authSession.state.session.user.locale
      : null;

  const { mutate: pushLocale } = useMutation(
    orpc.auth.updateLocale.mutationOptions({
      // Background preference sync — a failure must not toast; the next
      // locale change or app visit re-attempts it.
      meta: { skipGlobalErrorToast: true },
    }),
  );
  // One push per locale value, so a slow mutation (or a session store that
  // hasn't refetched the updated user yet) doesn't re-fire on every param
  // change.
  const pushedLocale = useRef<string | null>(null);

  useEffect(() => {
    if (!userLocale) return;
    if (!isSupportedLocale(userLocale)) return;
    if (typeof window === "undefined") return;
    // localStorage is the explicit "I picked this on this device" signal —
    // honor it over the server-side preference. It can also be AHEAD of the
    // server: the public pages' language switcher persists only to
    // localStorage (no session machinery there), so push the device choice up
    // before bailing out.
    const stored = window.localStorage.getItem("locale");
    if (stored) {
      if (isSupportedLocale(stored) && stored !== userLocale && pushedLocale.current !== stored) {
        pushedLocale.current = stored;
        pushLocale({ locale: stored });
      }
      return;
    }
    // No-op when the URL is already in the right locale (the common case
    // after the very first render).
    const currentLang = isSupportedLocale(params.lang) ? params.lang : null;
    if (currentLang === userLocale) return;
    // Fall through to the URL-driven language swap in `routes/$lang.tsx`'s
    // beforeLoad. We only navigate when the URL actually carries a `lang`
    // param; the brief `/` redirect window handles itself.
    if (currentLang) {
      void router.navigate({
        to: ".",
        params: (p) => ({ ...p, lang: userLocale }),
        search: (s) => s,
        replace: true,
      });
    } else {
      // Fallback: i18next is the source of truth until the URL settles.
      void i18n.changeLanguage(userLocale);
    }
  }, [userLocale, params.lang, router, pushLocale]);
}
