import { Button } from "@knowledge-base/ui/components/button";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { useTranslation } from "react-i18next";

import { type ExportKind, type ExportState, useKbExport } from "@/hooks/use-kb-export";

const KB_ID = /^[a-z0-9]{24,32}$/;

/**
 * Smart-HTTP clone URL. Only the origin's scheme/host/port survive: embedded
 * credentials, path, query and fragment are dropped so no secret is copyable.
 */
export function gitCloneUrl(origin: string, kbId: string): string {
  if (!KB_ID.test(kbId)) throw new Error("Invalid knowledge base id");
  const base = new URL(origin);
  return `${base.protocol}//${base.host}/git/${kbId}.git`;
}

type ViewProps = {
  cloneUrl: string;
  state: ExportState;
  onExport: (kind: ExportKind) => void;
};

export function KbDownloadsView({ cloneUrl, state, onExport }: ViewProps) {
  const { t } = useTranslation("kb");
  const busy = state.status === "preparing" || state.status === "downloading";
  return (
    <section data-testid="kb-downloads" className="min-w-0 space-y-3 rounded-md border p-4">
      <h2 className="text-sm font-medium">{t("downloads.title")}</h2>
      <div className="flex flex-wrap gap-2">
        {(["assets", "whole"] as const).map((kind) => (
          <Button
            key={kind}
            type="button"
            variant="outline"
            className="min-h-[44px]"
            disabled={busy}
            onClick={() => onExport(kind)}
          >
            {t(kind === "assets" ? "downloads.assetsZip" : "downloads.wholeZip")}
          </Button>
        ))}
      </div>
      {(state.status === "preparing" ||
        state.status === "downloading" ||
        state.status === "done") && (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {state.status === "done"
            ? t("downloads.done", { size: state.size })
            : t(state.status === "preparing" ? "downloads.preparing" : "downloads.downloading")}
        </p>
      )}
      {(state.status === "expired" || state.status === "error") && (
        <p role="alert" className="text-sm text-destructive">
          {t(state.status === "expired" ? "downloads.expired" : "downloads.error")}
        </p>
      )}
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-medium">{t("downloads.cloneTitle")}</h3>
        <CopyField value={cloneUrl} copyLabel={t("downloads.copyClone")} />
        <p className="text-sm text-muted-foreground">{t("downloads.cloneHint")}</p>
      </div>
    </section>
  );
}

/** Downloads panel for one KB revision: ZIP exports plus the Git clone URL. */
export function KbDownloads({
  kbId,
  rev,
  origin,
  prepare,
  complete,
}: {
  kbId: string;
  rev: string;
  origin: string;
  prepare: Parameters<typeof useKbExport>[0]["prepare"];
  complete: Parameters<typeof useKbExport>[0]["complete"];
}) {
  const { state, start } = useKbExport({ kbId, rev, prepare, complete });
  return (
    <KbDownloadsView
      cloneUrl={gitCloneUrl(origin, kbId)}
      state={state}
      onExport={(kind) => void start(kind)}
    />
  );
}
