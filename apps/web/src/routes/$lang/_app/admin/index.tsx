import { buttonVariants } from "@knowledge-base/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@knowledge-base/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ListX, Settings, Users } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import { BackupStatusCard } from "@/components/admin/backup-status-card";
import { PageHeader, PageShell } from "@/components/page-shell";
import { pageHead } from "@/lib/page-title";
import { orpc } from "@/utils/orpc";

export const Route = createFileRoute("/$lang/_app/admin/")({
  head: ({ match }) => pageHead(match.context.i18n.t("nav:items.admin")),
  component: AdminOverview,
});

function AdminOverview() {
  const { lang } = Route.useParams();
  const { t } = useTranslation(["admin", "common"]);
  // Same cached query as the app-shell banner (ADMIN_EMAIL is restart-time).
  const { data: setup } = useQuery({
    ...orpc.settings.adminSetupStatus.queryOptions(),
    staleTime: 5 * 60 * 1000,
  });

  return (
    <PageShell width="wide">
      <PageHeader title={t("admin:overview.title")} description={t("admin:overview.description")} />
      {setup?.adminEmailsEmpty && setup.adminExists && (
        <p data-testid="admin-bootstrap-note" className="text-sm text-muted-foreground">
          <Trans
            i18nKey="setupBanner.firstAccountAdmin"
            ns="admin"
            components={[<code key="0" className="font-mono" />]}
          />
        </p>
      )}
      <BackupStatusCard />
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(
          [
            { to: "/$lang/admin/users", label: t("admin:nav.users"), icon: Users },
            { to: "/$lang/admin/jobs", label: t("admin:nav.jobs"), icon: ListX },
            { to: "/$lang/admin/settings", label: t("admin:nav.settings"), icon: Settings },
          ] as const
        ).map((item) => (
          <Card key={item.to}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <item.icon aria-hidden="true" className="size-4" />
                {item.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <Link
                to={item.to}
                params={{ lang }}
                className={buttonVariants({ variant: "secondary", className: "max-md:min-h-11" })}
                aria-label={t("admin:overview.manageSection", { section: item.label })}
              >
                {t("common:actions.manage")}
              </Link>
            </CardContent>
          </Card>
        ))}
      </section>
    </PageShell>
  );
}
