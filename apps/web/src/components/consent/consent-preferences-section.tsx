import { Label } from "@knowledge-base/ui/components/label";
import { useTranslation } from "react-i18next";

import { analyticsConfigured } from "@/lib/analytics";

import { ConsentPreferencesButton } from "./consent-preferences-button";

/**
 * The Settings block around Cookie preferences, so a signed-in visitor can
 * withdraw consent too. Only an app with analytics (`analyticsConfigured`,
 * lib/analytics.ts) has a choice to revisit; without it the whole block,
 * heading included, renders nothing.
 */
export function ConsentPreferencesSection() {
  const { t } = useTranslation("consent");

  if (!analyticsConfigured) return null;

  return (
    <div className="mt-6 space-y-2 border-t pt-6">
      <Label>{t("preferences.title")}</Label>
      <p className="text-muted-foreground text-sm">{t("preferences.description")}</p>
      <ConsentPreferencesButton />
    </div>
  );
}
