import { Button } from "@knowledge-base/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@knowledge-base/ui/components/card";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { createFileRoute, Link, redirect, useLocation, useRouter } from "@tanstack/react-router";
import { type ReactNode, useRef } from "react";
import { useTranslation } from "react-i18next";
import { AuthScreen } from "@/components/auth/auth-screen";
import { InlineRetry } from "@/components/inline-retry";
import { AclPicker } from "@/components/kb/acl-picker";
import { buildSignedOAuthQuery, useMcpConsent } from "@/hooks/use-mcp-consent";
import { useMobileKeyboard } from "@/hooks/use-mobile-keyboard";
import { useMountEffect } from "@/hooks/use-mount-effect";
import { MAIN_SCROLLER_ID } from "@/lib/main-scroller";
import { pageHead } from "@/lib/page-title";
import { decideProtectedRouteAccess } from "@/lib/route-session-access";
import { getRouteSession } from "@/server/auth-session";

/**
 * MCP OAuth consent (Better Auth `consentPage`). Everything rendered about the
 * request comes from `mcpConsent.prepare` (server-verified signed query and DB
 * rows); the URL is only forwarded, never trusted. Approval submits the durable
 * nonce/reference and an explicit selection; only the provider's own redirect
 * counts as success.
 */
export const Route = createFileRoute("/$lang/mcp-consent")({
  validateSearch: (search: Record<string, unknown>) => search,
  ssr: false,
  beforeLoad: async ({ params }) => {
    const decision = decideProtectedRouteAccess(await getRouteSession());
    if (decision.kind === "error") throw new Error("Route session unavailable");
    if (decision.kind === "redirect-to-login") {
      throw redirect({
        href: `/${params.lang}/mcp-login${window.location.search}`,
        reloadDocument: true,
      });
    }
  },
  head: ({ match }) => pageHead(match.context.i18n.t("nav:titles.mcpConsent")),
  component: McpConsentPage,
});

function McpConsentPage() {
  useMobileKeyboard();
  // Router searchStr is reserialized and collapses repeated ba_param keys.
  // History already owns the raw destination when the browser URL flush is
  // still queued, so same-route navigation must read it rather than window.
  const router = useRouter();
  const rawSearch = useLocation({ select: () => router.history.location.search });
  // A bare route (outside the app shell), so it supplies its own landmark.
  return (
    <main
      data-scroll-restoration-id={MAIN_SCROLLER_ID}
      className="relative h-svh min-w-0 overflow-y-auto overflow-x-clip overscroll-contain pt-[var(--safe-area-top)] pr-[var(--safe-area-right)] pb-[var(--safe-area-bottom)] pl-[var(--safe-area-left)] [scrollbar-gutter:stable]"
    >
      <McpConsentFlow key={buildSignedOAuthQuery(rawSearch) ?? "unsigned"} rawSearch={rawSearch} />
    </main>
  );
}

function McpConsentFlow({ rawSearch }: { rawSearch: string }) {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["consent", "settings", "common"]);
  const consent = useMcpConsent(rawSearch, true);
  const { review, kbs, phase } = consent;

  if (phase.kind === "restart") {
    return (
      <StatusCard title={t("consent:mcp.restartTitle")} body={t("consent:mcp.restartBody")}>
        <Button className="min-h-[44px]" onClick={() => window.location.reload()}>
          {t("consent:mcp.startOver")}
        </Button>
        <Button
          variant="outline"
          className="min-h-[44px]"
          render={<Link to="/$lang/settings/mcp" params={{ lang }} />}
        >
          {t("consent:mcp.manageApps")}
        </Button>
      </StatusCard>
    );
  }
  if (phase.kind === "incomplete" || phase.kind === "uncertain") {
    return (
      <StatusCard
        title={t(`consent:mcp.${phase.kind}Title`)}
        body={t(`consent:mcp.${phase.kind}Body`)}
      >
        <Button className="min-h-[44px]" onClick={() => consent.submit()}>
          {t("consent:mcp.retryExact")}
        </Button>
        <Button
          variant="outline"
          className="min-h-[44px]"
          render={<Link to="/$lang/settings/mcp" params={{ lang }} />}
        >
          {t("consent:mcp.manageApps")}
        </Button>
      </StatusCard>
    );
  }
  if (phase.kind === "redirecting") {
    return (
      <StatusCard
        title={t("consent:mcp.redirecting")}
        body={phase.reused ? t("consent:mcp.reused") : undefined}
      />
    );
  }
  if (phase.kind === "denied") return <StatusCard title={t("consent:mcp.denied")} />;
  if (phase.kind === "sealed")
    return <StatusCard title={t("consent:mcp.sealedTitle")} body={t("consent:mcp.sealedBody")} />;
  if (review.isError) {
    return (
      <AuthScreen>
        <InlineRetry message={t("consent:mcp.errorBody")} onRetry={() => review.refetch()} />
      </AuthScreen>
    );
  }
  if (review.isPending || kbs.query.isPending) return <ConsentSkeleton />;

  const data = review.data;
  const client = data.client.name ?? t("consent:mcp.unnamedClient");
  const busy = phase.kind === "submitting";
  return (
    <AuthScreen>
      <Card className="my-8 w-full max-w-xl">
        <CardHeader>
          <CardTitle className="text-2xl break-words">
            {t("consent:mcp.title", { client })}
          </CardTitle>
          <CardDescription>{t("consent:mcp.description", { client })}</CardDescription>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 pt-2 text-xs">
            <dt className="text-muted-foreground">{t("consent:mcp.clientId")}</dt>
            <dd className="min-w-0 break-all font-mono">{data.client.clientId}</dd>
            <dt className="text-muted-foreground">{t("consent:mcp.redirect")}</dt>
            <dd className="min-w-0 break-all font-mono">{data.redirectUri}</dd>
            <dt className="text-muted-foreground">{t("consent:mcp.resource")}</dt>
            <dd className="min-w-0 break-all font-mono">{data.resource}</dd>
          </dl>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.previousGrantId && (
            <p className="rounded-md border p-3 text-sm">{t("consent:mcp.previous")}</p>
          )}
          {kbs.query.isError ? (
            <InlineRetry
              message={t("settings:credentials.kbsLoadError")}
              onRetry={() => kbs.query.refetch()}
            />
          ) : (
            <AclPicker
              live={kbs.live}
              selection={consent.selection}
              onChange={consent.dispatch}
              scopeMode="fixed"
              fixedScopes={data.scopes}
              writeScopeSelected={data.scopes.includes("mcp:write")}
              disabled={busy}
            />
          )}
          {kbs.query.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px]"
              disabled={kbs.query.isFetchingNextPage}
              onClick={() => kbs.query.fetchNextPage()}
            >
              {t("common:actions.loadMore")}
            </Button>
          )}
          {consent.issues.map((issue) => (
            <p key={issue} className="text-sm text-muted-foreground">
              {t(`settings:credentials.picker.issues.${issue}`)}
            </p>
          ))}
          {phase.kind === "error" && (
            <InlineRetry
              variant="destructive"
              message={t("consent:mcp.errorBody")}
              onRetry={consent.resetError}
            />
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            className="min-h-[44px]"
            disabled={busy}
            onClick={() => consent.submit(true)}
          >
            {t("consent:mcp.deny")}
          </Button>
          <Button
            className="min-h-[44px]"
            disabled={busy || phase.kind === "error" || consent.issues.length > 0}
            onClick={() => consent.submit(false)}
          >
            {busy ? t("consent:mcp.approving") : t("consent:mcp.approve")}
          </Button>
        </CardFooter>
      </Card>
    </AuthScreen>
  );
}

function StatusCard({
  title,
  body,
  children,
}: {
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Move focus to the outcome so keyboard and screen-reader users hear it.
  useMountEffect(() => heading.current?.focus());
  return (
    <AuthScreen>
      <Card className="w-full max-w-md" role="status">
        <CardHeader>
          <h1 ref={heading} tabIndex={-1} className="text-xl font-semibold outline-none">
            {title}
          </h1>
          {body && <CardDescription>{body}</CardDescription>}
        </CardHeader>
        {children && <CardFooter>{children}</CardFooter>}
      </Card>
    </AuthScreen>
  );
}

function ConsentSkeleton() {
  return (
    <AuthScreen>
      <div className="w-full max-w-xl space-y-4">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-24 w-full rounded-md" />
        <Skeleton className="h-24 w-full rounded-md" />
        <div className="flex justify-end gap-2">
          <Skeleton className="h-11 w-24" />
          <Skeleton className="h-11 w-24" />
        </div>
      </div>
    </AuthScreen>
  );
}
