import { Button } from "@knowledge-base/ui/components/button";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { useTranslation } from "react-i18next";

import {
  type DownloadState,
  type ExportJob,
  type ExportKind,
  type ExportView,
  type StartError,
  useKbExport,
} from "@/hooks/use-kb-export";

const KB_ID = /^[a-z0-9]{24,32}$/;
/** Failure codes with their own message; anything else reads as a storage failure. */
const FAILURE_KEYS = new Set([
  "DEADLINE_EXCEEDED",
  "INTERRUPTED",
  "QUOTA_EXCEEDED",
  "ACCESS_DENIED",
  "REVISION_NOT_FOUND",
  "INVALID_CONTENT",
  "STORAGE_UNAVAILABLE",
]);

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
  view: ExportView;
  startError: StartError | null;
  starting: boolean;
  cancelling: boolean;
  cancelFailed: boolean;
  onExport: (kind: ExportKind) => void;
  onCancel: () => void;
  onDownload: () => void;
  onRetryLookup: () => void;
};

function JobLabel({ job }: { job: ExportJob }) {
  const { t } = useTranslation("kb");
  return (
    <p className="text-sm font-medium">
      {t("downloads.job", {
        kind: t(job.kind === "assets" ? "downloads.kindAssets" : "downloads.kindWhole"),
        rev: job.rev.slice(0, 7),
      })}
    </p>
  );
}

function ReadyJob({
  job,
  download,
  cancelling,
  onCancel,
  onDownload,
}: {
  job: ExportJob;
  download: DownloadState | null;
  cancelling: boolean;
  onCancel: () => void;
  onDownload: () => void;
}) {
  const { t } = useTranslation("kb");
  return (
    <div className="min-w-0 space-y-2">
      <JobLabel job={job} />
      {download?.status === "done" ? (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {t("downloads.done", { size: download.size })}
        </p>
      ) : (
        <>
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {download?.status === "downloading"
              ? t("downloads.downloading")
              : t("downloads.ready", { size: job.size ?? 0 })}
          </p>
          {(download?.status === "expired" || download?.status === "error") && (
            <p role="alert" className="text-sm text-destructive">
              {t(download.status === "expired" ? "downloads.expired" : "downloads.error")}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              className="min-h-[44px]"
              disabled={download?.status === "downloading"}
              onClick={onDownload}
            >
              {t("downloads.download")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="min-h-[44px]"
              disabled={cancelling || download?.status === "downloading"}
              onClick={onCancel}
            >
              {t("downloads.discard")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function JobPanel({
  view,
  cancelling,
  onExport,
  onCancel,
  onDownload,
}: Omit<ViewProps, "cloneUrl" | "starting" | "startError" | "cancelFailed" | "onRetryLookup">) {
  const { t } = useTranslation("kb");
  if (view.status === "loading")
    return <Skeleton data-testid="kb-downloads-loading" className="h-11 w-full" />;
  if (view.status === "idle") return null;
  const { job } = view;
  if (view.status === "preparing")
    return (
      <div className="min-w-0 space-y-2">
        <JobLabel job={job} />
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.percent ?? undefined}
          aria-label={t("downloads.progressLabel")}
          className="h-2 w-full overflow-hidden rounded bg-muted"
        >
          <div className="h-full bg-primary" style={{ width: `${view.percent ?? 0}%` }} />
        </div>
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {view.percent === null
            ? t("downloads.preparing")
            : t("downloads.preparingProgress", { percent: view.percent })}
        </p>
        <p className="text-sm text-muted-foreground">{t("downloads.keepsRunning")}</p>
        <Button
          type="button"
          variant="outline"
          className="min-h-[44px]"
          disabled={cancelling}
          onClick={onCancel}
        >
          {t("downloads.cancel")}
        </Button>
      </div>
    );
  if (view.status === "ready")
    return (
      <ReadyJob
        job={job}
        download={view.download}
        cancelling={cancelling}
        onCancel={onCancel}
        onDownload={onDownload}
      />
    );
  if (view.status === "failed")
    return (
      <div className="min-w-0 space-y-2">
        <JobLabel job={job} />
        <p role="alert" className="text-sm text-destructive">
          {t(
            `downloads.failure.${FAILURE_KEYS.has(job.error?.code ?? "") ? job.error!.code : "STORAGE_UNAVAILABLE"}`,
          )}
        </p>
        <Button
          type="button"
          variant="outline"
          className="min-h-[44px]"
          onClick={() => onExport(job.kind)}
        >
          {t("downloads.retry")}
        </Button>
      </div>
    );
  return (
    <p
      role={view.status === "expired" ? "alert" : "status"}
      className={
        view.status === "expired" ? "text-sm text-destructive" : "text-sm text-muted-foreground"
      }
    >
      {t(view.status === "expired" ? "downloads.expired" : "downloads.cancelled")}
    </p>
  );
}

export function KbDownloadsView({
  cloneUrl,
  view,
  startError,
  starting,
  cancelling,
  cancelFailed,
  onExport,
  onCancel,
  onDownload,
  onRetryLookup,
}: ViewProps) {
  const { t } = useTranslation("kb");
  const busy = starting || view.status === "loading" || view.status === "preparing";
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
      {view.status === "idle" && view.lookupFailed && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{t("downloads.lookupFailed")}</span>
          <Button type="button" variant="outline" className="min-h-[44px]" onClick={onRetryLookup}>
            {t("downloads.tryAgain")}
          </Button>
        </div>
      )}
      {startError && (
        <p role="alert" className="text-sm text-destructive">
          {t(startError === "capacity" ? "downloads.capacity" : "downloads.error")}
        </p>
      )}
      {cancelFailed && (view.status === "preparing" || view.status === "ready") && (
        <p role="alert" className="text-sm text-destructive">
          {t("downloads.cancelFailed")}
        </p>
      )}
      <JobPanel
        view={view}
        cancelling={cancelling}
        onExport={onExport}
        onCancel={onCancel}
        onDownload={onDownload}
      />
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-medium">{t("downloads.cloneTitle")}</h3>
        <CopyField value={cloneUrl} copyLabel={t("downloads.copyClone")} />
        <p className="text-sm text-muted-foreground">{t("downloads.cloneHint")}</p>
      </div>
    </section>
  );
}

/** Downloads panel for one KB revision: background ZIP exports plus the Git clone URL. */
export function KbDownloads({ kbId, rev, origin }: { kbId: string; rev: string; origin: string }) {
  const exportJob = useKbExport({ kbId, rev });
  return (
    <KbDownloadsView
      cloneUrl={gitCloneUrl(origin, kbId)}
      view={exportJob.view}
      startError={exportJob.startError}
      starting={exportJob.starting}
      cancelling={exportJob.cancelling}
      cancelFailed={exportJob.cancelFailed}
      onExport={(kind) => void exportJob.start(kind)}
      onCancel={exportJob.cancel}
      onDownload={() => void exportJob.download()}
      onRetryLookup={exportJob.retryLookup}
    />
  );
}
