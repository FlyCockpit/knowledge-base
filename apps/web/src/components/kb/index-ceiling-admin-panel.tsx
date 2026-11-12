import type { AppRouterClient } from "@knowledge-base/api/routers/index";
import { Button } from "@knowledge-base/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@knowledge-base/ui/components/card";
import { toast } from "@knowledge-base/ui/components/sileo";
import { Skeleton } from "@knowledge-base/ui/components/skeleton";
import { TextField } from "@knowledge-base/ui/components/text-field";
import { useForm } from "@tanstack/react-form";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { InlineRetry } from "@/components/inline-retry";
import { QUANTIZATIONS, type Quantization } from "@/components/kb/index-settings-panel";
import { invalidateIndexSettings } from "@/hooks/use-index-settings-sync";
import { orpc } from "@/utils/orpc";

type CeilingView = Awaited<ReturnType<AppRouterClient["kbIndex"]["chunkCeiling"]>>;

/** Stores the new ceilings and refreshes every KB's settings (their maxLimit/caps derive from them). */
export function applyCeilingSaved(queryClient: QueryClient, next: CeilingView): void {
  queryClient.setQueryData(orpc.kbIndex.chunkCeiling.queryKey(), next);
  void invalidateIndexSettings(queryClient);
}

/** One field per quantization; the server refuses anything above that quantization's bound. */
function CeilingRow({
  quantization,
  ceiling,
  bound,
}: {
  quantization: Quantization;
  ceiling: number;
  bound: number;
}) {
  const { t } = useTranslation("admin");
  const queryClient = useQueryClient();
  const save = useMutation(
    orpc.kbIndex.setChunkCeiling.mutationOptions({
      onSuccess: (next) => {
        applyCeilingSaved(queryClient, next);
        toast.success(t("settings.indexCeiling.saved"));
      },
    }),
  );
  const form = useForm({
    defaultValues: { amount: String(ceiling) },
    validators: {
      onSubmit: z.object({
        amount: z
          .string()
          .trim()
          .regex(/^[1-9]\d{0,8}$/, t("settings.indexCeiling.boundExceeded", { bound }))
          .refine(
            (value) => Number(value) <= bound,
            t("settings.indexCeiling.boundExceeded", { bound }),
          ),
      }),
    },
    onSubmit: ({ value }) => save.mutate({ quantization, amount: Number(value.amount.trim()) }),
  });
  const reason = (save.error as { data?: { reason?: unknown } } | null)?.data?.reason;
  return (
    <form
      data-testid="index-ceiling-row"
      data-quantization={quantization}
      className="flex min-w-0 flex-wrap items-end gap-2 rounded-lg border p-4"
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
            className="min-w-0 flex-1"
            label={t(`settings.indexCeiling.label.${quantization}`)}
            description={t("settings.indexCeiling.help", { bound })}
            autoComplete="off"
            inputMode="numeric"
            maxLength={9}
          />
        )}
      </form.Field>
      <Button
        type="submit"
        className="min-h-[44px]"
        disabled={save.isPending}
        // One Save per quantization: the name says which (R2-19).
        aria-label={t("settings.indexCeiling.saveNamed", {
          name: t(`settings.indexCeiling.label.${quantization}`),
        })}
      >
        {save.isPending ? t("settings.indexCeiling.saving") : t("settings.indexCeiling.save")}
      </Button>
      {save.isError && (
        <p role="alert" className="w-full text-sm text-destructive">
          {reason === "CHUNK_CEILING_ABOVE_BOUND" || reason === "INVALID_AMOUNT"
            ? t("settings.indexCeiling.boundExceeded", { bound })
            : t("settings.indexCeiling.failed")}
        </p>
      )}
    </form>
  );
}

export function IndexCeilingFields({ view }: { view: CeilingView }) {
  return (
    <div className="space-y-3">
      {QUANTIZATIONS.map((q) => (
        <CeilingRow
          key={`${q}:${view[q].ceiling}`}
          quantization={q}
          ceiling={view[q].ceiling}
          bound={view[q].bound}
        />
      ))}
    </div>
  );
}

/** Instance-admin per-quantization chunk ceilings (§1.9), next to the model panel. */
export function IndexCeilingAdminPanel() {
  const { t } = useTranslation("admin");
  const { data, isPending, isError, refetch } = useQuery(
    orpc.kbIndex.chunkCeiling.queryOptions({ retry: false }),
  );
  return (
    <Card data-testid="index-ceiling-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Layers className="size-5" />
          {t("settings.indexCeiling.title")}
        </CardTitle>
        <CardDescription>{t("settings.indexCeiling.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="space-y-3">
            {QUANTIZATIONS.map((q) => (
              <Skeleton key={q} className="h-20 w-full" />
            ))}
          </div>
        ) : isError || !data ? (
          <InlineRetry message={t("settings.indexCeiling.loadFailed")} onRetry={() => refetch()} />
        ) : (
          <IndexCeilingFields view={data} />
        )}
      </CardContent>
    </Card>
  );
}
