import { Button } from "@knowledge-base/ui/components/button";
import { cn } from "@knowledge-base/ui/lib/utils";
import { Pin, PinOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useKbPins } from "@/hooks/use-kb-pins";

/**
 * Pin / unpin one knowledge base (it then heads the sidebar's list). A toggle
 * button: `aria-pressed` says whether it is pinned. `compact` shows the icon
 * only (the name is still its accessible name).
 */
export function KbPinButton({
  kbId,
  kbName,
  kbSlug = "",
  compact = false,
  className,
}: {
  kbId: string;
  kbName: string;
  kbSlug?: string;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useTranslation("kb");
  const pins = useKbPins();
  const pinned = pins.isPinned(kbId);
  // A toggle keeps one name; `aria-pressed` carries the state (the tooltip says what a click does).
  const label = t("pins.pinNamed", { name: kbName });
  const hint = t(pinned ? "pins.unpinNamed" : "pins.pinNamed", { name: kbName });
  const Icon = pinned ? PinOff : Pin;
  return (
    <Button
      type="button"
      variant={compact ? "ghost" : "outline"}
      size={compact ? "icon-touch" : "touch"}
      aria-pressed={pinned}
      aria-label={label}
      title={hint}
      disabled={pins.isPending || pins.busy}
      data-testid="kb-pin"
      className={cn(className)}
      onClick={() => (pinned ? pins.unpin(kbId) : pins.pin({ kbId, name: kbName, slug: kbSlug }))}
    >
      <Icon aria-hidden className={cn("size-4", pinned && "text-primary")} />
      {!compact && <span>{t(pinned ? "pins.pinned" : "pins.pin")}</span>}
    </Button>
  );
}
