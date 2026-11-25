import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { InstanceLimitsAdminPanel } from "@/components/kb/instance-limits-admin-panel";
import { PageHeader, PageShell } from "@/components/page-shell";
import { pageHead } from "@/lib/page-title";

export const Route = createFileRoute("/$lang/_app/admin/limits")({
  head: ({ match }) =>
    pageHead(match.context.i18n.t("admin:nav.limits"), match.context.i18n.t("nav:items.admin")),
  component: AdminLimits,
});

function AdminLimits() {
  const { t } = useTranslation("admin");
  return (
    <PageShell width="narrow">
      <PageHeader title={t("limits.title")} description={t("limits.description")} />
      <InstanceLimitsAdminPanel />
    </PageShell>
  );
}
