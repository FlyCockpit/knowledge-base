import { buttonVariants } from "@knowledge-base/ui/components/button";
import { Link } from "@tanstack/react-router";
import { FileQuestion } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * The router's not-found page (R2-13): unknown URLs, and unknown sub-paths of
 * a layout that renders its `<Outlet />` (e.g. `/kbs/<id>/pull-requests`).
 * Inside the app shell it keeps the surrounding navigation. A layout that
 * already shows its own `h1` (Settings) renders it as `nested`, so the page
 * keeps one `h1` (R3-W9).
 */
export default function NotFoundState({ nested = false }: { nested?: boolean }) {
  const { t } = useTranslation("errors");
  const Heading = nested ? "h2" : "h1";
  return (
    <div
      data-testid="not-found"
      className="flex h-full min-h-[50svh] flex-col items-center justify-center gap-3 px-6 py-8 text-center"
    >
      <FileQuestion aria-hidden className="size-8 text-muted-foreground" />
      <div className="space-y-1">
        <Heading className="text-lg font-semibold">{t("pageNotFound.title")}</Heading>
        <p className="text-sm text-muted-foreground">{t("pageNotFound.description")}</p>
      </div>
      <Link to="/" className={buttonVariants({ size: "touch" })}>
        {t("pageNotFound.home")}
      </Link>
    </div>
  );
}
