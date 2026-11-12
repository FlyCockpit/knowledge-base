import { UiLabelsProvider } from "@knowledge-base/ui/components/ui-labels";
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";

export function UiLabelsBridge({ children }: { children: ReactNode }) {
  const { t } = useTranslation("common");
  const close = t("actions.close");
  const labels = useMemo(() => ({ close }), [close]);
  return <UiLabelsProvider labels={labels}>{children}</UiLabelsProvider>;
}
