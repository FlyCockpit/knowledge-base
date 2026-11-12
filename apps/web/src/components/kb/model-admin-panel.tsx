import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { Button } from "@knowledge-base/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@knowledge-base/ui/components/card";
import { Checkbox } from "@knowledge-base/ui/components/checkbox";
import { CopyField } from "@knowledge-base/ui/components/copy-field";
import { Label } from "@knowledge-base/ui/components/label";
import { SelectItem } from "@knowledge-base/ui/components/select";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { SelectField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmActionDialog } from "@/components/confirm-action-dialog";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { InlineRetry } from "@/components/inline-retry";
import { orpc } from "@/utils/orpc";

type ModelState = "DISABLED" | "DOWNLOADING" | "READY" | "FAILED";
type ModelStatus = Awaited<ReturnType<AppRouterClient["kbModel"]["status"]>>;
type ModelErrorCode =
  | "MODEL_HOST_REJECTED"
  | "MODEL_PRIVATE_NETWORK"
  | "MODEL_REDIRECT_LIMIT"
  | "MODEL_HTTP_STATUS"
  | "MODEL_SIZE_MISMATCH"
  | "MODEL_CHECKSUM_MISMATCH"
  | "MODEL_DOWNLOAD_FAILED"
  | "MODEL_DISK_QUOTA"
  | "MODEL_RUNTIME_UNSUPPORTED"
  | "MODEL_VOLUME_BUSY";

type KvType = "f16" | "q8_0" | "q4_0";
type MemoryLevel = "ok" | "warn" | "block" | "unknown";
const CONTEXT_OPTIONS = [1024, 2048, 4096, 8192] as const;
const KV_TYPES: readonly KvType[] = ["f16", "q8_0", "q4_0"];
export type RuntimeConfigLike = {
  modelId: string;
  contextTokens: number;
  kvKeyType: KvType;
  kvValueType: KvType;
};

export type LocalModelStatusLike = {
  modelId: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  state: ModelState;
  epoch: number;
  bytesDownloaded: number;
  totalBytes: number;
  progress: number;
  errorCode: ModelErrorCode | null;
  reservedBytes: number;
  executable: boolean;
  runtime: Omit<RuntimeConfigLike, "modelId"> & { batchTokens: number; flashAttention: boolean };
  memory: {
    budgetBytes: number | null;
    availableBytes: number | null;
    source: "cgroup-v2" | "cgroup-v1" | "meminfo" | null;
    reportedAt: string | null;
  };
  peakRssBytes: number | null;
  estimates: Array<
    RuntimeConfigLike & {
      bytes: number;
      source: "measured" | "estimated";
      percent: number | null;
      level: MemoryLevel;
      recommended?: boolean;
      smaller?: boolean;
    }
  >;
  /** "Remove" was requested; the worker deletes the downloaded weights shortly. */
  removalPending: boolean;
  reembed: { total: number; done: number; failed: number; currentKbId: string | null };
  pendingConfig:
    | (RuntimeConfigLike & {
        state: "queued" | "probing";
        mode: "side-by-side" | "exclusive" | null;
      })
    | null;
  configError:
    | (Omit<RuntimeConfigLike, "modelId"> & {
        code:
          | "MODEL_CONFIG_PROBE_FAILED"
          | "MODEL_CONFIG_PROBE_TIMEOUT"
          | "MODEL_CONFIG_PROBE_INTERRUPTED";
        at: string;
      })
    | null;
};

const sameConfig = (a: RuntimeConfigLike, b: RuntimeConfigLike) =>
  a.modelId === b.modelId &&
  a.contextTokens === b.contextTokens &&
  a.kvKeyType === b.kvKeyType &&
  a.kvValueType === b.kvValueType;

/**
 * What applying `selection` would do. The server re-checks the same gate
 * (> 90% of the reported budget is rejected, > 70% needs acknowledgement).
 */
export function runtimeSelection(status: LocalModelStatusLike, selection: RuntimeConfigLike) {
  const row = status.estimates.find((r) => sameConfig(r, selection)) ?? null;
  const level: MemoryLevel = row?.level ?? "unknown";
  const changed = !sameConfig({ ...status.runtime, modelId: status.modelId }, selection);
  return {
    row,
    level,
    changed,
    needsAck: level === "warn",
    canApply: changed && (level === "ok" || level === "warn"),
  };
}

/**
 * Which admin actions the actual server state allows; the server rechecks. Disable keeps the
 * downloaded weights; Remove (only once disabled or failed) deletes them.
 */
export function modelControls(status: Pick<LocalModelStatusLike, "state" | "removalPending">): {
  enable: boolean;
  disable: boolean;
  remove: boolean;
} {
  const off = status.state === "DISABLED" || status.state === "FAILED";
  return {
    enable: off,
    disable: status.state !== "DISABLED",
    remove: off && !status.removalPending,
  };
}

/**
 * R2-23: after "Apply settings" the panel keeps polling until the status shows the applied
 * selection active, or its load probe failed, instead of relying on the pending flag alone.
 */
export function awaitingApplied(
  status: Pick<LocalModelStatusLike, "modelId" | "runtime" | "configError">,
  applied: RuntimeConfigLike | null,
): boolean {
  if (!applied) return false;
  if (sameConfig({ ...status.runtime, modelId: status.modelId }, applied)) return false;
  // Probe errors describe the last requested config, whose model is the applied selection.
  return !(
    status.configError && sameConfig({ ...status.configError, modelId: applied.modelId }, applied)
  );
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const configValues = (config: Omit<RuntimeConfigLike, "modelId">) => ({
  contextTokens: config.contextTokens,
  k: String(config.kvKeyType),
  v: String(config.kvValueType),
});

/**
 * Current runtime, reported budget, real peak next to the estimate, the pending
 * config's load probe, the last rejected config, re-embed progress.
 */
export function ModelRuntimeView({ status }: { status: LocalModelStatusLike }) {
  const { t } = useTranslation("admin");
  const { runtime, memory, reembed, pendingConfig, configError } = status;
  const current = runtimeSelection(status, { ...runtime, modelId: status.modelId }).row;
  return (
    <div className="space-y-1 text-sm text-muted-foreground" data-testid="model-runtime">
      <p className="text-foreground">
        {t("settings.model.runtime.current", {
          contextTokens: runtime.contextTokens,
          k: String(runtime.kvKeyType),
          v: String(runtime.kvValueType),
          batch: runtime.batchTokens,
        })}
      </p>
      {memory.budgetBytes === null ? (
        <p>{t("settings.model.runtime.budgetUnknown")}</p>
      ) : (
        <p>
          {t("settings.model.runtime.budget", {
            budget: mib(memory.budgetBytes),
            source: memory.source ? t(`settings.model.runtime.budgetSource.${memory.source}`) : "",
            available: mib(memory.availableBytes ?? 0),
          })}
        </p>
      )}
      {current ? (
        <p>{t("settings.model.runtime.estimate", { estimate: mib(current.bytes) })}</p>
      ) : null}
      <p data-testid="runtime-peak">
        {status.peakRssBytes === null
          ? t("settings.model.runtime.peakUnknown")
          : t("settings.model.runtime.peak", { peak: mib(status.peakRssBytes) })}
      </p>
      {pendingConfig ? (
        <p data-testid="runtime-pending" className="text-foreground">
          {t(
            pendingConfig.state === "queued"
              ? "settings.model.runtime.pending.queued"
              : pendingConfig.mode === "exclusive"
                ? "settings.model.runtime.pending.probingExclusive"
                : "settings.model.runtime.pending.probing",
            configValues(pendingConfig),
          )}
        </p>
      ) : null}
      {configError ? (
        <p data-testid="runtime-config-error" className="text-destructive">
          {t(`settings.model.runtime.probeError.${configError.code}`, configValues(configError))}
        </p>
      ) : null}
      {reembed.total > 0 ? (
        <div data-testid="reembed-progress" className="space-y-1">
          <p>
            {t("settings.model.runtime.reembedProgress", {
              done: reembed.done + reembed.failed,
              total: reembed.total,
            })}
          </p>
          {reembed.currentKbId ? (
            <p>{t("settings.model.runtime.reembedCurrent", { kbId: reembed.currentKbId })}</p>
          ) : null}
          {reembed.failed > 0 ? (
            <p className="text-destructive">
              {t("settings.model.runtime.reembedFailed", { count: reembed.failed })}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Per-context estimate and share of the budget for the chosen cache types. */
export function RuntimeOptionsTable({
  status,
  kvKeyType,
  kvValueType,
  selected,
  selectedModelId,
}: {
  status: LocalModelStatusLike;
  kvKeyType: KvType;
  kvValueType: KvType;
  selected: number;
  selectedModelId?: string;
}) {
  const { t } = useTranslation("admin");
  return (
    <div className="overflow-x-auto" data-testid="model-options">
      <table className="w-full text-sm">
        <caption className="sr-only">{t("settings.model.runtime.optionsCaption")}</caption>
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 pr-3 font-medium">{t("settings.model.runtime.columns.context")}</th>
            <th className="py-1 pr-3 font-medium">
              {t("settings.model.runtime.columns.estimate")}
            </th>
            <th className="py-1 pr-3 font-medium">{t("settings.model.runtime.columns.share")}</th>
            <th className="py-1 font-medium">{t("settings.model.runtime.columns.status")}</th>
          </tr>
        </thead>
        <tbody>
          {status.estimates
            .filter(
              (row) =>
                row.modelId === "embeddinggemma-2-q8_0" ||
                (row.kvKeyType === kvKeyType && row.kvValueType === kvValueType),
            )
            .map((row) => (
              <tr
                key={`${row.modelId}:${row.contextTokens}`}
                data-context={row.contextTokens}
                data-model={row.modelId}
                data-level={row.level}
                aria-disabled={row.level === "block" || row.level === "unknown" ? true : undefined}
                aria-current={
                  row.contextTokens === selected &&
                  row.modelId === (selectedModelId ?? status.modelId)
                    ? "true"
                    : undefined
                }
                className={
                  row.level === "block" || row.level === "unknown"
                    ? "text-muted-foreground opacity-60"
                    : undefined
                }
              >
                <td className="py-1 pr-3">
                  {t(
                    row.modelId === "embeddinggemma-2-q8_0"
                      ? "settings.model.models.gemma"
                      : "settings.model.models.qwen",
                  )}{" "}
                  {row.contextTokens}
                </td>
                <td className="py-1 pr-3">
                  {mib(row.bytes)} ({t(`settings.model.runtime.source.${row.source}`)})
                </td>
                <td className="py-1 pr-3">
                  {row.percent === null ? "—" : `${Math.round(row.percent)}%`}
                </td>
                <td className="py-1">
                  {t(`settings.model.runtime.level.${row.level}`)}
                  {row.recommended ? (
                    <span className="ml-2 text-foreground">{t("settings.model.recommended")}</span>
                  ) : null}
                  {row.smaller ? <span className="ml-2">{t("settings.model.smaller")}</span> : null}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

/** Admin runtime settings form; the server is authoritative for the memory gate. */
function RuntimeConfigForm({
  status,
  onApplied,
}: {
  status: LocalModelStatusLike;
  onApplied: (applied: RuntimeConfigLike, next: ModelStatus) => void;
}) {
  const { t } = useTranslation("admin");
  const ackId = useId();
  const apply = useMutation({
    ...orpc.kbModel.setRuntimeConfig.mutationOptions({
      onSuccess: (next, { acknowledgeMemoryWarning: _ack, ...applied }) =>
        onApplied({ ...applied, modelId: applied.modelId ?? status.modelId }, next),
    }),
    meta: { errorFallbackKey: "admin:settings.model.runtime.applyFailed" },
  });
  // Applying reloads the model and re-embeds every attached KB: confirm with
  // the impact first (R3-W9).
  const [confirming, setConfirming] = useState<Parameters<typeof apply.mutate>[0] | null>(null);
  const form = useForm({
    defaultValues: {
      modelId: status.modelId,
      contextTokens: String(status.runtime.contextTokens),
      kvKeyType: status.runtime.kvKeyType as string,
      kvValueType: status.runtime.kvValueType as string,
      acknowledge: false,
    },
    onSubmit: ({ value }) => {
      setConfirming({
        modelId: value.modelId,
        contextTokens: Number(value.contextTokens) as (typeof CONTEXT_OPTIONS)[number],
        kvKeyType: value.kvKeyType as KvType,
        kvValueType: value.kvValueType as KvType,
        acknowledgeMemoryWarning: value.acknowledge,
      });
    },
  });
  return (
    <>
      <ConfirmActionDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title={t("settings.model.runtime.applyConfirmTitle")}
        description={t("settings.model.runtime.applyConfirmDescription")}
        confirmLabel={t("settings.model.runtime.apply")}
        onConfirm={() => {
          if (confirming) apply.mutate(confirming);
          setConfirming(null);
        }}
      >
        <AffectedKnowledgeBases open={confirming !== null} />
      </ConfirmActionDialog>
      <form
        className="min-w-0 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          form.handleSubmit();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <form.Field
            name="modelId"
            listeners={{
              onChange: () => {
                form.setFieldValue("kvKeyType", "f16");
                form.setFieldValue("kvValueType", "f16");
              },
            }}
          >
            {(field) => (
              <SelectField
                field={field}
                label={t("settings.model.modelLabel")}
                valueLabel={t(
                  field.state.value === "embeddinggemma-2-q8_0"
                    ? "settings.model.models.gemma"
                    : "settings.model.models.qwen",
                )}
              >
                <SelectItem value="embeddinggemma-2-q8_0" className="min-h-[44px]">
                  {t("settings.model.models.gemma")}
                </SelectItem>
                <SelectItem value="qwen3-embedding-0.6b-q8_0" className="min-h-[44px]">
                  {t("settings.model.models.qwen")}
                </SelectItem>
              </SelectField>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.values}>
            {(values) => (
              <>
                <form.Field name="contextTokens">
                  {(field) => (
                    <SelectField field={field} label={t("settings.model.runtime.contextLabel")}>
                      {CONTEXT_OPTIONS.map((value) => (
                        <SelectItem
                          key={value}
                          value={String(value)}
                          className="min-h-[44px]"
                          disabled={
                            runtimeSelection(status, {
                              modelId: values.modelId,
                              contextTokens: value,
                              kvKeyType: values.kvKeyType as KvType,
                              kvValueType: values.kvValueType as KvType,
                            }).level === "block"
                          }
                        >
                          {value}
                        </SelectItem>
                      ))}
                    </SelectField>
                  )}
                </form.Field>
                <form.Field name="kvKeyType">
                  {(field) => (
                    <SelectField field={field} label={t("settings.model.runtime.kvKeyLabel")}>
                      {KV_TYPES.filter(
                        (value) => values.modelId !== "embeddinggemma-2-q8_0" || value === "f16",
                      ).map((value) => (
                        <SelectItem key={value} value={value} className="min-h-[44px]">
                          {t(`settings.model.runtime.kvTypes.${value}`)}
                        </SelectItem>
                      ))}
                    </SelectField>
                  )}
                </form.Field>
                <form.Field name="kvValueType">
                  {(field) => (
                    <SelectField field={field} label={t("settings.model.runtime.kvValueLabel")}>
                      {KV_TYPES.filter(
                        (value) => values.modelId !== "embeddinggemma-2-q8_0" || value === "f16",
                      ).map((value) => (
                        <SelectItem key={value} value={value} className="min-h-[44px]">
                          {t(`settings.model.runtime.kvTypes.${value}`)}
                        </SelectItem>
                      ))}
                    </SelectField>
                  )}
                </form.Field>{" "}
              </>
            )}
          </form.Subscribe>
        </div>
        <form.Subscribe selector={(state) => state.values}>
          {(values) => {
            const selection = {
              modelId: values.modelId,
              contextTokens: Number(values.contextTokens),
              kvKeyType: values.kvKeyType as KvType,
              kvValueType: values.kvValueType as KvType,
            };
            const decision = runtimeSelection(status, selection);
            return (
              <div className="space-y-3">
                <RuntimeOptionsTable
                  status={status}
                  kvKeyType={selection.kvKeyType}
                  kvValueType={selection.kvValueType}
                  selected={selection.contextTokens}
                  selectedModelId={selection.modelId}
                />
                {decision.changed ? (
                  <p className="text-sm text-muted-foreground">
                    {t("settings.model.runtime.reindexNotice")}
                  </p>
                ) : null}
                {decision.needsAck ? (
                  <form.Field name="acknowledge">
                    {(field) => (
                      <div className="flex min-h-[44px] items-start gap-3">
                        <Checkbox
                          id={ackId}
                          checked={field.state.value}
                          onCheckedChange={(checked) => field.handleChange(checked === true)}
                          aria-labelledby={`${ackId}-label`}
                          className="mt-1"
                        />
                        <Label id={`${ackId}-label`} htmlFor={ackId} className="leading-snug">
                          {t("settings.model.runtime.acknowledge")}
                        </Label>
                      </div>
                    )}
                  </form.Field>
                ) : null}
                <Button
                  type="submit"
                  size="sm"
                  className="min-h-[44px]"
                  disabled={
                    apply.isPending ||
                    !decision.canApply ||
                    (decision.needsAck && !values.acknowledge)
                  }
                >
                  {apply.isPending ? t("settings.updating") : t("settings.model.runtime.apply")}
                </Button>
              </div>
            );
          }}
        </form.Subscribe>
      </form>
    </>
  );
}

export function ModelStatusView({ status }: { status: LocalModelStatusLike }) {
  const { t } = useTranslation("admin");
  const percent = Math.round(Math.min(Math.max(status.progress, 0), 1) * 100);
  return (
    <div className="space-y-3" data-state={status.state} data-testid="model-status">
      <p className="font-medium">{t(`settings.model.states.${status.state}`)}</p>
      <div className="space-y-1 text-sm text-muted-foreground">
        <p>
          {t("settings.model.fileName", { fileName: status.fileName, size: mib(status.sizeBytes) })}
        </p>
        <CopyField value={status.sha256} copyLabel={t("settings.model.copySha256")} />
      </div>
      {status.state === "DOWNLOADING" ? (
        <div className="space-y-1">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t("settings.model.progressLabel")}
            className="h-2 w-full overflow-hidden rounded bg-muted"
          >
            <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
          <p className="text-sm text-muted-foreground">
            {t("settings.model.progress", {
              percent,
              done: mib(status.bytesDownloaded),
              total: mib(status.totalBytes),
            })}
          </p>
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">
        {t("settings.model.disk", { reserved: mib(status.reservedBytes) })}
      </p>
      {status.state === "FAILED" && status.errorCode ? (
        <p className="text-sm text-destructive">{t(`settings.model.errors.${status.errorCode}`)}</p>
      ) : null}
      {status.executable ? (
        <p className="text-sm text-muted-foreground" data-testid="model-executable">
          {t("settings.model.executable")}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="model-not-executable">
          {t("settings.model.notExecutable")}
        </p>
      )}
    </div>
  );
}

/** Admin card: actual DB-backed status, enable/disable, polling while downloading. */
export function ModelAdminPanel() {
  const { t } = useTranslation("admin");
  const queryClient = useQueryClient();
  const [enableAcknowledged, setEnableAcknowledged] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [applied, setApplied] = useState<RuntimeConfigLike | null>(null);
  const enableAckId = useId();
  const statusKey = orpc.kbModel.status.queryKey();
  const { data, isPending, isError, refetch } = useQuery({
    ...orpc.kbModel.status.queryOptions(),
    // Poll while downloading, while a config awaits its load probe or an applied selection is
    // not active yet (R2-23), while weights are being removed, or while re-embedding runs.
    refetchInterval: (query) => {
      const current = query.state.data;
      if (!current) return false;
      if (
        current.state === "DOWNLOADING" ||
        current.pendingConfig ||
        current.removalPending ||
        awaitingApplied(current, applied)
      )
        return 2_000;
      const { total, done, failed } = current.reembed;
      return done + failed < total ? 5_000 : false;
    },
  });
  // The mutation's reply is the fresh status: show it at once, then refetch every model query.
  const onSuccess = (next: ModelStatus) => {
    queryClient.setQueryData(statusKey, next);
    return queryClient.invalidateQueries({ queryKey: orpc.kbModel.key() });
  };
  const enable = useMutation({
    ...orpc.kbModel.enable.mutationOptions({ onSuccess }),
    meta: { errorFallbackKey: "admin:settings.model.updateFailed" },
  });
  const disable = useMutation({
    ...orpc.kbModel.disable.mutationOptions({ onSuccess }),
    meta: { errorFallbackKey: "admin:settings.model.updateFailed" },
  });
  const remove = useMutation({
    ...orpc.kbModel.remove.mutationOptions({
      onSuccess: (next) => {
        setConfirmRemove(false);
        return onSuccess(next);
      },
    }),
    meta: { errorFallbackKey: "admin:settings.model.removeFailed" },
  });
  const busy = enable.isPending || disable.isPending || remove.isPending;
  const enableDecision = data
    ? runtimeSelection(data, { ...data.runtime, modelId: data.modelId })
    : null;
  const controls = data ? modelControls(data) : { enable: false, disable: false, remove: false };
  return (
    <Card data-testid="model-admin-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="size-5" />
          {t("settings.model.title")}
        </CardTitle>
        <CardDescription>{t("settings.model.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-full max-w-md" />
            <Skeleton className="h-9 w-24" />
          </div>
        ) : isError ? (
          <InlineRetry message={t("settings.model.loadFailed")} onRetry={() => refetch()} />
        ) : (
          <>
            <ModelStatusView status={data} />
            <div className="space-y-3 border-t pt-4">
              <p className="font-medium">{t("settings.model.runtime.title")}</p>
              <p className="text-sm text-muted-foreground">
                {t("settings.model.runtime.description", { batch: data.runtime.batchTokens })}
              </p>
              <ModelRuntimeView status={data} />
              <RuntimeConfigForm
                // Remount on a server-side change so the form starts from the live config.
                key={`${data.modelId}-${data.runtime.contextTokens}-${data.runtime.kvKeyType}-${data.runtime.kvValueType}`}
                status={data}
                onApplied={(selection, next) => {
                  setApplied(selection);
                  return onSuccess(next);
                }}
              />
            </div>
            {controls.enable && enableDecision?.needsAck ? (
              <div className="flex min-h-[44px] items-center gap-3">
                <Checkbox
                  id={enableAckId}
                  checked={enableAcknowledged}
                  onCheckedChange={(value) => setEnableAcknowledged(value === true)}
                />
                <Label htmlFor={enableAckId}>{t("settings.model.runtime.acknowledge")}</Label>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {controls.enable ? (
                <Button
                  size="sm"
                  className="min-h-[44px]"
                  disabled={
                    busy ||
                    !enableDecision ||
                    enableDecision.level === "unknown" ||
                    enableDecision.level === "block" ||
                    (enableDecision.needsAck && !enableAcknowledged)
                  }
                  aria-label={t("settings.model.enableLabel")}
                  onClick={() => enable.mutate({ acknowledgeMemoryWarning: enableAcknowledged })}
                >
                  {enable.isPending ? t("settings.updating") : t("settings.model.enable")}
                </Button>
              ) : null}
              {controls.disable ? (
                <Button
                  size="sm"
                  variant="destructive"
                  className="min-h-[44px]"
                  disabled={busy}
                  aria-label={t("settings.model.disableLabel")}
                  onClick={() => setConfirmDisable(true)}
                >
                  {disable.isPending ? t("settings.updating") : t("settings.model.disable")}
                </Button>
              ) : null}
              {controls.remove ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="min-h-[44px]"
                  disabled={busy}
                  onClick={() => setConfirmRemove(true)}
                >
                  {t("settings.model.remove")}
                </Button>
              ) : null}
            </div>
            <ConfirmActionDialog
              open={confirmDisable}
              onOpenChange={setConfirmDisable}
              title={t("settings.model.disableConfirmTitle")}
              description={t("settings.model.disableConfirmDescription")}
              confirmLabel={t("settings.model.disable")}
              destructive
              onConfirm={() => {
                setConfirmDisable(false);
                disable.mutate(undefined);
              }}
            >
              <AffectedKnowledgeBases open={confirmDisable} />
            </ConfirmActionDialog>
            <p className="text-sm text-muted-foreground" data-testid="model-keeps-weights">
              {data.removalPending
                ? t("settings.model.removalPending")
                : t("settings.model.disableKeepsWeights")}
            </p>
            <ConfirmDeleteDialog
              open={confirmRemove}
              onOpenChange={setConfirmRemove}
              title={t("settings.model.removeTitle")}
              description={t("settings.model.removeDescription", { fileName: data.fileName })}
              confirmToken="REMOVE"
              typePrompt={t("settings.model.removePrompt")}
              copyAriaLabel={t("settings.model.copyRemoveToken")}
              inputMode="text"
              confirmLabel={t("settings.model.removeAction")}
              pendingLabel={t("settings.updating")}
              isPending={remove.isPending}
              onConfirm={() => remove.mutate({ confirm: "REMOVE" })}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * How many knowledge bases a disable or a runtime change affects, fetched
 * while its confirmation is open.
 */
function AffectedKnowledgeBases({ open }: { open: boolean }) {
  const { t } = useTranslation("admin");
  const { data, isPending, isError, refetch } = useQuery({
    ...orpc.kbModel.attachedKnowledgeBases.queryOptions(),
    enabled: open,
    staleTime: 0,
    meta: { skipGlobalErrorToast: true },
  });
  if (isError)
    return (
      <InlineRetry message={t("settings.model.affectedUnknown")} onRetry={() => void refetch()} />
    );
  if (isPending) return <Skeleton className="h-5 w-64" />;
  return (
    <p className="text-sm font-medium" data-testid="model-affected-kbs">
      {data.count === 0
        ? t("settings.model.affectedNone")
        : t("settings.model.affected", { count: data.count })}
    </p>
  );
}
