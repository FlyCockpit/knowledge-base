import { Button } from "@knowledge-base/ui/components/button";
import { useTranslation } from "react-i18next";

import { useConsent } from "@/hooks/use-consent";

/**
 * "Cookie preferences" — clears the stored decision so the banner comes back
 * and the visitor can choose again. Withdrawing consent has to be as easy as
 * giving it, so this must stay reachable from a page anonymous visitors can
 * see (the public footer) as well as from account settings.
 */
export function ConsentPreferencesButton({ className }: { className?: string }) {
  const { t } = useTranslation("consent");
  const { reset } = useConsent();

  return (
    <Button variant="outline" size="touch" className={className} onClick={reset}>
      {t("preferences.open")}
    </Button>
  );
}
