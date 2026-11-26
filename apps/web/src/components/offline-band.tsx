import { cn } from "@knowledge-base/ui/lib/utils";
import { Wifi, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PAGE_COLUMN_CLASS } from "@/components/page-shell";
import { useConnectivityNotice } from "@/hooks/use-connectivity-notice";

/**
 * The app-wide offline band. Both shells render it in their top row, above
 * `<main>`, so it takes its own space in the flow: it never covers the page,
 * the BottomNav or the cookie banner. See docs/ui.md § Offline
 *
 * The live region is always mounted (empty while online), so assistive tech
 * announces "You're offline" once when it appears and "Back online" once on
 * reconnect. The fade is `motion-safe:` only.
 */
export function OfflineBand() {
  const notice = useConnectivityNotice();
  const { t } = useTranslation("common");
  return (
    <div role="status" aria-live="polite" aria-atomic="true" data-offline-band="">
      {notice && (
        // Full-bleed band, content in the page column (docs/ui.md § Viewport scale).
        <div className="border-b bg-muted motion-safe:animate-in motion-safe:fade-in-0">
          <p
            className={cn(
              PAGE_COLUMN_CLASS,
              "flex min-w-0 items-center gap-2 py-1.5 text-sm text-foreground",
            )}
          >
            {notice === "offline" ? (
              <WifiOff aria-hidden="true" className="size-4 shrink-0 text-state-warning" />
            ) : (
              <Wifi aria-hidden="true" className="size-4 shrink-0 text-state-success" />
            )}
            <span className="min-w-0">
              {notice === "offline" ? t("offline.band") : t("offline.backOnline")}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
