import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AuthScreen } from "@/components/auth/auth-screen";
import { InlineRetry } from "@/components/inline-retry";
import { DeviceApproval, DeviceCodeForm } from "@/components/kb/device-approval";
import { useAuthSession } from "@/hooks/use-auth-session";
import { normalizeUserCode, useDeviceApproval } from "@/hooks/use-device-approval";
import { useMobileKeyboard } from "@/hooks/use-mobile-keyboard";
import { MAIN_SCROLLER_ID } from "@/lib/main-scroller";
import { pageHead } from "@/lib/page-title";
import { decideProtectedRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";

/**
 * Device (CLI) approval — the Better Auth `verificationUri`. Any signed-in user
 * approves their own CLI (not admin-only). The URL's `user_code` is only a
 * lookup key: everything shown comes from the cookie-bound GET claim, and the
 * selection is the user's explicit picker choice.
 */
export const Route = createFileRoute("/$lang/device")({
  validateSearch: (search: Record<string, unknown>) => ({
    user_code:
      typeof search.user_code === "string"
        ? search.user_code
        : typeof search.user_code === "number" && Number.isSafeInteger(search.user_code)
          ? String(search.user_code)
          : undefined,
  }),
  ssr: false,
  beforeLoad: async ({ params }) => {
    const decision = decideProtectedRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-to-login") {
      const back = `/${params.lang}/device${window.location.search}`;
      throw redirect({
        href: `/${params.lang}/login?redirectTo=${encodeURIComponent(back)}`,
        reloadDocument: true,
      });
    }
  },
  head: ({ match }) => pageHead(match.context.i18n.t("consent:device.title")),
  component: DevicePage,
});

function DevicePage() {
  useMobileKeyboard();
  const { user_code } = Route.useSearch();
  const navigate = Route.useNavigate();
  const userCode = normalizeUserCode(user_code);
  // A bare route (outside the app shell), so it supplies its own landmark.
  return (
    <main
      data-scroll-restoration-id={MAIN_SCROLLER_ID}
      className="relative h-svh min-w-0 overflow-y-auto overflow-x-clip overscroll-contain pt-[var(--safe-area-top)] pr-[var(--safe-area-right)] pb-[var(--safe-area-bottom)] pl-[var(--safe-area-left)] [scrollbar-gutter:stable]"
    >
      {userCode === null ? (
        <DeviceCodeForm
          invalid={user_code !== undefined}
          onSubmit={(raw) =>
            navigate({ search: { user_code: normalizeUserCode(raw) ?? raw }, replace: true })
          }
        />
      ) : (
        <DeviceFlow key={userCode} userCode={userCode} />
      )}
    </main>
  );
}

function DeviceFlow({ userCode }: { userCode: string }) {
  const navigate = Route.useNavigate();
  const session = useAuthSession();
  const { t } = useTranslation("consent");
  const { lang } = Route.useParams();
  const device = useDeviceApproval(userCode);
  const { claim, kbs, phase } = device;

  if (claim.isError) {
    return (
      <AuthScreen>
        <InlineRetry message={t("device.errorBody")} onRetry={() => claim.refetch()} />
      </AuthScreen>
    );
  }
  const terminal = !device.claimed;
  if (claim.isPending || (!terminal && kbs.query.isPending)) return <DeviceSkeleton />;
  const back = `/${lang}/device?user_code=${userCode}`;
  return (
    <DeviceApproval
      phase={phase}
      claim={device.claimed}
      live={kbs.live}
      kbs={{
        isError: kbs.query.isError,
        hasNextPage: kbs.query.hasNextPage,
        isFetchingNextPage: kbs.query.isFetchingNextPage,
        onRetry: () => kbs.query.refetch(),
        onLoadMore: () => kbs.query.fetchNextPage(),
      }}
      selection={device.selection}
      recipients={device.recipients}
      onAddRecipient={device.addRecipient}
      onRemoveRecipient={device.removeRecipient}
      onChange={device.dispatch}
      issues={device.issues}
      onApprove={() => device.submit("approve")}
      onDeny={() => device.submit("deny")}
      onRetry={device.resetError}
      onReviewAgain={device.reviewAgain}
      onSignIn={async () => {
        await session.actions.refetch();
        await navigate({ to: "/$lang/login", params: { lang }, search: { redirectTo: back } });
      }}
    />
  );
}

function DeviceSkeleton() {
  return (
    <AuthScreen>
      <div className="w-full max-w-xl space-y-4">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-24 w-full rounded-md" />
        <div className="flex justify-end gap-2">
          <Skeleton className="h-11 w-24" />
          <Skeleton className="h-11 w-24" />
        </div>
      </div>
    </AuthScreen>
  );
}
