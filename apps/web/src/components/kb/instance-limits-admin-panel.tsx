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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { useTranslation } from "react-i18next";
import { z } from "zod";

import { InlineRetry } from "@/components/inline-retry";
import { orpc } from "@/utils/orpc";

export type InstanceLimitsView = Awaited<ReturnType<AppRouterClient["settings"]["instanceLimits"]>>;
const INSTANCE_LIMIT_NAMES = ["createsPerHour", "ownedLiveKbs", "childTokensPerApiKey"] as const;
type LimitName = (typeof INSTANCE_LIMIT_NAMES)[number];
type LimitValues = Record<LimitName, string>;

/** A whole number within the limit's bounds, else null. */
export function parseLimit(raw: string, bounds: { min: number; max: number }): number | null {
  const value = raw.trim();
  if (!/^[0-9]{1,6}$/.test(value)) return null;
  const number = Number(value);
  return number >= bounds.min && number <= bounds.max ? number : null;
}

/** Only the limits that changed (the server takes any non-empty subset); null when invalid. */
export function instanceLimitsPatch(
  view: InstanceLimitsView,
  values: LimitValues,
): Partial<Record<LimitName, number>> | null {
  const patch: Partial<Record<LimitName, number>> = {};
  for (const name of INSTANCE_LIMIT_NAMES) {
    const value = parseLimit(values[name], view[name]);
    if (value === null) return null;
    if (value !== view[name].value) patch[name] = value;
  }
  return patch;
}

/** The three instance limits as whole-number fields; saves only what changed. */
export function InstanceLimitsForm({ view }: { view: InstanceLimitsView }) {
  const { t } = useTranslation("admin");
  const queryClient = useQueryClient();
  const save = useMutation(
    orpc.settings.setInstanceLimits.mutationOptions({
      onSuccess: (next) => {
        queryClient.setQueryData(orpc.settings.instanceLimits.queryKey(), next);
        toast.success(t("limits.saved"));
      },
    }),
  );
  const field = (name: LimitName) =>
    z
      .string()
      .refine(
        (value) => parseLimit(value, view[name]) !== null,
        t("limits.invalid", { min: view[name].min, max: view[name].max }),
      );
  const form = useForm({
    defaultValues: {
      createsPerHour: String(view.createsPerHour.value),
      ownedLiveKbs: String(view.ownedLiveKbs.value),
      childTokensPerApiKey: String(view.childTokensPerApiKey.value),
    } satisfies LimitValues,
    validators: {
      onSubmit: z.object({
        createsPerHour: field("createsPerHour"),
        ownedLiveKbs: field("ownedLiveKbs"),
        childTokensPerApiKey: field("childTokensPerApiKey"),
      }),
    },
    onSubmit: ({ value }) => {
      const patch = instanceLimitsPatch(view, value);
      if (patch === null) return;
      if (Object.keys(patch).length === 0) {
        toast.success(t("limits.unchanged"));
        return;
      }
      save.mutate(patch);
    },
  });
  return (
    <form
      data-testid="instance-limits-form"
      className="min-w-0 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        form.handleSubmit();
      }}
    >
      {INSTANCE_LIMIT_NAMES.map((name) => (
        <form.Field key={name} name={name}>
          {(fieldApi) => (
            <TextField
              field={fieldApi}
              label={t(`limits.fields.${name}.label`)}
              description={t("limits.help", {
                description: t(`limits.fields.${name}.description`),
                min: view[name].min,
                max: view[name].max,
                default: view[name].default,
              })}
              autoComplete="off"
              inputMode="numeric"
              maxLength={6}
            />
          )}
        </form.Field>
      ))}
      <Button type="submit" className="min-h-[44px]" disabled={save.isPending}>
        {save.isPending ? t("limits.saving") : t("limits.save")}
      </Button>
      {save.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t("limits.failed")}
        </p>
      )}
    </form>
  );
}

/** Instance-admin limits on KB creation, ownership and API-key child tokens. */
export function InstanceLimitsAdminPanel() {
  const { t } = useTranslation("admin");
  const { data, isPending, isError, refetch } = useQuery(
    orpc.settings.instanceLimits.queryOptions({ retry: false }),
  );
  return (
    <Card data-testid="instance-limits-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="size-5" />
          {t("limits.cardTitle")}
        </CardTitle>
        <CardDescription>{t("limits.cardDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="space-y-4">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : isError || !data ? (
          <InlineRetry message={t("limits.loadFailed")} onRetry={() => refetch()} />
        ) : (
          <InstanceLimitsForm
            key={INSTANCE_LIMIT_NAMES.map((name) => data[name].value).join(":")}
            view={data}
          />
        )}
      </CardContent>
    </Card>
  );
}
