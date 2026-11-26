import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@knowledge-base/ui/components/sheet";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";

import { SHORTCUTS } from "@/lib/kb-workspace/shortcuts";

/** `?`: every workspace shortcut, with this platform's keys. */
export function ShortcutsSheet({
  open,
  onOpenChange,
  mac,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mac: boolean;
}) {
  const { t } = useTranslation("kb");
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("workspace.shortcuts.title")}</SheetTitle>
          <SheetDescription>{t("workspace.shortcuts.description")}</SheetDescription>
        </SheetHeader>
        <ShortcutsList mac={mac} />
      </SheetContent>
    </Sheet>
  );
}

/** The sheet's list on its own (rendered statically in tests). */
export function ShortcutsList({ mac }: { mac: boolean }) {
  const { t } = useTranslation("kb");
  return (
    <div className="min-h-0 space-y-4 overflow-y-auto overflow-x-clip px-4 pb-[max(1rem,var(--safe-area-bottom,0px))]">
      <dl className="divide-y text-sm" data-testid="kb-shortcuts">
        {SHORTCUTS.map(({ command, keys }) => (
          <div key={command} className="flex items-center justify-between gap-4 py-2">
            <dt className="min-w-0">{t(`workspace.shortcuts.command.${command}`)}</dt>
            <dd className="flex shrink-0 flex-wrap items-center justify-end gap-1">
              {(mac ? keys.mac : keys.other).map((combo, index) => (
                <Fragment key={combo}>
                  {index > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {t("workspace.shortcuts.or")}
                    </span>
                  )}
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {combo}
                  </kbd>
                </Fragment>
              ))}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">{t("workspace.shortcuts.note")}</p>
    </div>
  );
}
