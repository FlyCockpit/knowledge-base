import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { Button } from "@knowledge-base/ui/components/button";
import { Label } from "@knowledge-base/ui/components/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@knowledge-base/ui/components/sheet";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { Help } from "@/components/help";
import { InlineRetry } from "@/components/inline-retry";
import { ControlError, describeControlError } from "@/components/kb/profile-panel";
import { invalidateIndexSettings, useIndexSettingsSync } from "@/hooks/use-index-settings-sync";
import { useKbMutationSession } from "@/hooks/use-kb-mutation-session";
import { usePayloadAttemptKey } from "@/hooks/use-payload-attempt-key";
import { orpc } from "@/utils/orpc";

type IndexSettings = Awaited<ReturnType<AppRouterClient["kbIndex"]["settings"]>>;
export type Quantization = IndexSettings["quantization"];
type KbLike = { id: string; capabilities: readonly string[] };

export const QUANTIZATIONS: readonly Quantization[] = ["int8", "binary_int8_rescore"];

const INDEX_SETTINGS_REASONS = [
  "INVALID_AMOUNT",
  "CHUNK_LIMIT_ABOVE_CEILING",
  "CHUNK_LIMIT_ABOVE_QUANTIZATION_BOUND",
  "ACTIVE_INDEX_TOO_LARGE",
] as const;
export type IndexSettingsReason = (typeof INDEX_SETTINGS_REASONS)[number];

/** The server's refusal reason (`data.reason`), when it is one this panel explains. */
export function refusalReasonOf(error: unknown): IndexSettingsReason | null {
  const reason = (error as { data?: { reason?: unknown } } | null)?.data?.reason;
  return typeof reason === "string" &&
    (INDEX_SETTINGS_REASONS as readonly string[]).includes(reason)
    ? (reason as IndexSettingsReason)
    : null;
}

/** Mirrors the server's setQuantization refusals so the select can explain them inline. */
export function quantizationRefusal(
  settings: Pick<IndexSettings, "limit" | "caps" | "activeChunkCount" | "defaultLimit">,
  q: Quantization,
): "CHUNK_LIMIT_ABOVE_QUANTIZATION_BOUND" | "ACTIVE_INDEX_TOO_LARGE" | null {
  const cap = settings.caps[q];
  if (settings.limit !== null && settings.limit > cap)
    return "CHUNK_LIMIT_ABOVE_QUANTIZATION_BOUND";
  if (
    settings.activeChunkCount !== null &&
    settings.activeChunkCount > Math.min(settings.limit ?? settings.defaultLimit, cap)
  )
    return "ACTIVE_INDEX_TOO_LARGE";
  return null;
}

/**
 * A denial means live authority changed (e.g. ownership moved while read remains):
 * refetch this KB's settings so owner-only controls follow `canConfigureLimit`.
 */
export function refreshSettingsOnDenial(
  queryClient: QueryClient,
  kbId: string,
  error: unknown,
): boolean {
  if (describeControlError(error) !== "denied") return false;
  void invalidateIndexSettings(queryClient, kbId);
  return true;
}

function SettingsError({ error, max }: { error: unknown; max: number }) {
  const { t } = useTranslation("kb");
  const reason = refusalReasonOf(error);
  if (!error) return null;
  if (!reason) return <ControlError error={error} />;
  return (
    <p role="alert" data-testid="index-settings-reason" className="text-sm text-destructive">
      {t(`settings.index.reasons.${reason}`, { max })}
    </p>
  );
}

export function IndexSettingsSummary({ settings }: { settings: IndexSettings }) {
  const { t } = useTranslation("kb");
  const clamped = settings.limit !== null && settings.limit > settings.effectiveLimit;
  return (
    <div data-testid="index-settings-summary" className="space-y-1 text-sm">
      <div className="flex items-center gap-1.5">
        {t("settings.index.quantizationCurrent", {
          name: t(`settings.index.quantization.${settings.quantization}`),
        })}
        <Help title={t("settings.index.quantizationLabel")}>
          <p>{t("settings.index.quantizationHelp")}</p>
        </Help>
      </div>
      <p data-testid="index-settings-limit">
        {settings.limit === null
          ? t("settings.index.limitDefaultLine", { limit: settings.effectiveLimit })
          : t("settings.index.limitCustomLine", { limit: settings.effectiveLimit })}
      </p>
      {clamped && (
        <p className="text-xs text-muted-foreground">
          {t("settings.index.limitClamped", {
            stored: settings.limit,
            limit: settings.effectiveLimit,
          })}
        </p>
      )}
      {settings.buildFailure && (
        <p
          role="alert"
          data-testid="index-build-failure"
          data-failure={settings.buildFailure}
          className="text-sm text-destructive"
        >
          {t(`settings.index.buildFailure.${settings.buildFailure}`)}
        </p>
      )}
    </div>
  );
}

/** Edit → Sheet. Owner-only (the server re-checks owner + manage under the KB row lock). */
function ChunkLimitSheet({
  kbId,
  settings,
  open,
  onOpenChange,
  onDenied,
}: {
  kbId: string;
  settings: IndexSettings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDenied: () => void;
}) {
  const { t } = useTranslation(["kb", "common"]);
  const queryClient = useQueryClient();
  const session = useKbMutationSession();
  const max = settings.maxLimit;
  const update = useMutation(
    orpc.kbIndex.setChunkLimit.mutationOptions({
      onSuccess: async (next) => {
        queryClient.setQueryData(orpc.kbIndex.settings.queryKey({ input: { kbId } }), next);
        if (!session.current) return;
        session.current = false;
        onOpenChange(false);
      },
      onError: (error) => {
        refreshSettingsOnDenial(queryClient, kbId, error);
        if (session.current && describeControlError(error) === "denied") {
          session.current = false;
          onOpenChange(false);
          onDenied();
        }
      },
    }),
  );
  const form = useForm({
    defaultValues: { amount: String(settings.limit ?? settings.effectiveLimit) },
    validators: {
      onSubmit: z.object({
        amount: z
          .string()
          .trim()
          .regex(/^[1-9]\d{0,8}$/, t("kb:settings.index.limitInvalid", { max }))
          .refine((value) => Number(value) <= max, t("kb:settings.index.limitInvalid", { max })),
      }),
    },
    onSubmit: ({ value }) => update.mutate({ kbId, amount: Number(value.amount.trim()) }),
  });
  const close = (next: boolean) => {
    if (!next) {
      session.current = false;
      form.reset();
      update.reset();
    }
    onOpenChange(next);
  };
  return (
    <Sheet open={open} onOpenChange={close}>
      <SheetContent className="overflow-y-auto overflow-x-hidden">
        <SheetHeader>
          <SheetTitle>{t("kb:settings.index.limitSheetTitle")}</SheetTitle>
          <SheetDescription>{t("kb:settings.index.limitSheetDescription")}</SheetDescription>
        </SheetHeader>
        <form
          className="min-w-0 space-y-4 px-4"
          onSubmit={(event) => {
            event.preventDefault();
            event.stopPropagation();
            form.handleSubmit();
          }}
        >
          <form.Field name="amount">
            {(field) => (
              <TextField
                field={field}
                label={t("kb:settings.index.limitLabel")}
                description={t("kb:settings.index.limitHelp", { max })}
                autoComplete="off"
                inputMode="numeric"
                maxLength={9}
              />
            )}
          </form.Field>
          <SettingsError error={update.error} max={max} />
          <SheetFooter className="flex-wrap gap-2 px-0">
            <Button
              type="button"
              variant="outline"
              data-testid="index-limit-reset"
              className="min-h-[44px]"
              disabled={update.isPending || settings.limit === null}
              onClick={() => update.mutate({ kbId, amount: null })}
            >
              {t("kb:settings.index.resetDefault", {
                limit: Math.min(settings.defaultLimit, settings.maxLimit),
              })}
            </Button>
            <Button
              type="submit"
              data-testid="index-limit-save"
              className="min-h-[44px]"
              disabled={update.isPending}
            >
              {update.isPending ? t("kb:settings.index.saving") : t("kb:settings.index.save")}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/**
 * The setQuantization input. The key is bound to the payload (`keyFor`): an identical
 * retry after a lost response replays the same key, a changed selection gets a new one.
 */
export function quantizationRequest(
  kbId: string,
  quantization: Quantization,
  keyFor: (payload: unknown) => string,
) {
  const payload = { kbId, quantization, confirm: "RUN" as const };
  return { ...payload, idempotencyKey: keyFor(payload) };
}

/** §1.9 per-KB index settings: quantization (manage, RUN-confirmed rebuild) and chunk limit (owner). */
export function IndexSettingsPanel({ kb, onDenied }: { kb: KbLike; onDenied: () => void }) {
  const { t } = useTranslation("kb");
  const queryClient = useQueryClient();
  const selectId = useId();
  const canManage = kb.capabilities.includes("manage");
  const [choice, setChoice] = useState<Quantization | "">("");
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const attempt = usePayloadAttemptKey();
  const session = useKbMutationSession();
  const settingsKey = orpc.kbIndex.settings.queryKey({ input: { kbId: kb.id } });
  const {
    data: settings,
    isPending,
    isError,
    refetch,
  } = useQuery(orpc.kbIndex.settings.queryOptions({ input: { kbId: kb.id }, retry: false }));
  // Builds settle on the profile query ProfilePanel already polls; follow its state.
  const { data: profile } = useQuery(
    orpc.kbIndex.profile.queryOptions({ input: { kbId: kb.id }, retry: false }),
  );
  useIndexSettingsSync(kb.id, profile?.index ?? null);
  const setQuantization = useMutation(
    orpc.kbIndex.setQuantization.mutationOptions({
      onSuccess: async () => {
        if (session.current) {
          setConfirming(false);
          setChoice("");
          attempt.settle();
        }
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: settingsKey }),
          queryClient.invalidateQueries({
            queryKey: orpc.kbIndex.profile.queryKey({ input: { kbId: kb.id } }),
          }),
        ]);
      },
      onError: (error) => {
        refreshSettingsOnDenial(queryClient, kb.id, error);
        if (!session.current) return;
        setConfirming(false);
        if (describeControlError(error) === "denied") onDenied();
      },
    }),
  );
  const refusal = settings && choice ? quantizationRefusal(settings, choice) : null;
  return (
    <section
      data-testid="index-settings-panel"
      aria-labelledby="kb-index-settings-title"
      className="min-w-0 space-y-4"
    >
      <header className="space-y-1">
        <h2 id="kb-index-settings-title" className="text-lg font-semibold">
          {t("settings.index.title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("settings.index.description")}</p>
      </header>
      {isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-5 w-56" />
          <Skeleton className="h-5 w-40" />
        </div>
      ) : isError || !settings ? (
        <InlineRetry message={t("settings.index.loadFailed")} onRetry={() => refetch()} />
      ) : (
        <>
          <IndexSettingsSummary settings={settings} />
          {settings.canConfigureLimit && (
            <Button
              data-testid="index-limit-edit"
              variant="outline"
              className="min-h-[44px]"
              onClick={() => setEditing(true)}
            >
              {t("settings.index.editLimit")}
            </Button>
          )}
          {canManage && (
            <div className="space-y-3">
              <div className="min-w-0 space-y-2">
                <Label htmlFor={selectId}>{t("settings.index.quantizationLabel")}</Label>
                <select
                  id={selectId}
                  data-testid="index-quantization-choice"
                  className="min-h-[44px] w-full rounded-md border bg-background px-3 text-sm"
                  value={choice}
                  onChange={(event) => setChoice(event.target.value as Quantization | "")}
                >
                  <option value="">{t("settings.index.quantizationPlaceholder")}</option>
                  {QUANTIZATIONS.map((q) => (
                    <option key={q} value={q}>
                      {t("settings.index.quantizationOption", {
                        name: t(`settings.index.quantization.${q}`),
                        cap: settings.caps[q],
                      })}
                    </option>
                  ))}
                </select>
              </div>
              {refusal && (
                <p
                  data-testid="index-quantization-refusal"
                  className="text-sm text-muted-foreground"
                >
                  {t(`settings.index.reasons.${refusal}`, {
                    max: choice ? settings.caps[choice] : settings.maxLimit,
                  })}
                </p>
              )}
              <Button
                data-testid="index-quantization-apply"
                className="min-h-[44px]"
                disabled={!choice || refusal !== null || setQuantization.isPending}
                onClick={() => setConfirming(true)}
              >
                {t("settings.index.applyQuantization")}
              </Button>
              <SettingsError
                error={setQuantization.error}
                max={choice ? settings.caps[choice] : settings.maxLimit}
              />
              {setQuantization.isSuccess && (
                <p role="status" className="text-sm">
                  {t("settings.profile.started")}
                </p>
              )}
            </div>
          )}
          {editing && (
            <ChunkLimitSheet
              kbId={kb.id}
              settings={settings}
              open={editing}
              onOpenChange={setEditing}
              onDenied={onDenied}
            />
          )}
        </>
      )}
      <ConfirmDeleteDialog
        open={confirming}
        onOpenChange={(open) => !open && setConfirming(false)}
        title={t("settings.index.confirmTitle")}
        description={t(
          profile?.profile?.kind === "SYSTEM_BUILTIN"
            ? "settings.index.confirmBuiltinDescription"
            : "settings.index.confirmDescription",
        )}
        confirmToken="RUN"
        typePrompt={t("settings.profile.confirmPrompt")}
        copyAriaLabel={t("settings.members.copyToken")}
        inputMode="text"
        confirmLabel={t("settings.profile.confirmAction")}
        pendingLabel={t("settings.members.pending")}
        isPending={setQuantization.isPending}
        onConfirm={() => {
          if (choice) setQuantization.mutate(quantizationRequest(kb.id, choice, attempt.keyFor));
        }}
      />
    </section>
  );
}
